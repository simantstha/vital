import SwiftUI

// MARK: - Root view

struct CoachView: View {
    @StateObject private var vm: CoachViewModel
    /// Observed directly (not through `vm`, which no longer forwards its
    /// `objectWillChange` — spec §4's perf note) so the mic button and
    /// composer re-render on every voice-state/transcript change without
    /// making every token of a *typed* reply also walk through this view's
    /// diffing. Always `vm.voiceController` — the same shared instance
    /// Today's `VoiceFABView` drives.
    @ObservedObject private var voice: CoachVoiceController
    /// While the cloud STT upload (or its on-device fallback) is resolving —
    /// `voice.state == .transcribing`, given a name since it's read from
    /// several places below.
    private var isTranscribing: Bool { voice.state == .transcribing }
    @Namespace private var bottomAnchor
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// Set once the user taps the mic while permission is denied, so the
    /// inline "go to Settings" hint only appears after they've actually
    /// tried voice — not as a permanent nag.
    @State private var didAttemptDeniedMic = false
    @State private var isScrolledNearBottom = true
    @State private var scrollPhase: ScrollPhase = .idle
    @FocusState private var composerFocused: Bool
    /// Guards the mic button's touch-down gesture (spec §3.1/§10 V3: start
    /// on finger down, not tap-up) so `DragGesture`'s repeated `onChanged`
    /// firings while a finger is held down only trigger the mic action once
    /// per press. Reset in `onEnded`.
    @State private var isMicPressed = false
    /// Set on touch-down only when that press actually starts a *new*
    /// recording (not one that stops an in-flight one) — the gesture
    /// mapping (spec §3.1, V5) reads it back at release to tell a quick tap
    /// (conversation mode) from a ≥300 ms hold (push-to-talk single turn).
    @State private var micPressStartedAt: Date? = nil

    /// `mode` is forwarded to every `/api/coach` call via `CoachViewModel`.
    /// The Coach tab uses the default (nil); the onboarding CoachIntro step
    /// passes `"onboarding"`.
    init(mode: String? = nil, initialMessage: String? = nil) {
        let model = CoachViewModel(mode: mode)
        model.input = initialMessage ?? ""
        _vm = StateObject(wrappedValue: model)
        _voice = ObservedObject(wrappedValue: model.voiceController)
    }

    /// Used by `RootTabView`, which owns a single `CoachViewModel` shared
    /// with Today's voice FAB — so a transcript sent from Today
    /// (`CoachViewModel.sendExternalVoiceTranscript`) lands in the exact same
    /// thread the user sees here. `StateObject(wrappedValue:)` is safe with
    /// an externally-owned instance as long as the same instance is passed
    /// on every re-init, which it is here (`coachVM` is itself a
    /// `@StateObject` on `RootTabView`, stable across re-renders).
    init(vm: CoachViewModel) {
        _vm = StateObject(wrappedValue: vm)
        _voice = ObservedObject(wrappedValue: vm.voiceController)
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                navigationBar
                messageList
                inputBar
            }

            #if DEBUG
            voiceTurnHUD
            #endif
        }
        // Fetch a fresh, data-aware opener when the Coach tab appears.
        // Check for stale conversations on every appearance.
        .task {
            vm.refreshIfStale()
            vm.loadOpener()
        }
        // Spec §3.4/§10 V3: pre-warm the shared voice session/engine the
        // moment the Coach tab is on screen, so the first real tap has less
        // to do. No-op unless mic permission is already authorized, and
        // never prompts for it.
        .onAppear { voice.prewarm() }
        // Leaving the view mid-stream (e.g. onboarding CoachIntro → Continue)
        // must not leave a stream task running against a gone view.
        .onDisappear { vm.cancelStreaming() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                vm.refreshIfStale()
            }
        }
        // Spec §3.2, V5: "app backgrounded > 10 s" ends conversation mode.
        // Wired at `RootTabView` (always mounted, regardless of which tab
        // is active) rather than here, since a conversation the Today FAB
        // started can still be mid-first-listen when the app backgrounds,
        // before `onSent` has switched to this tab.
    }

    // MARK: - Navigation bar

    /// D4 (one coach voice): Vital is always the speaker in the nav bar, even
    /// mid-specialist-consultation — no more persona header switch. A
    /// specialist's contribution surfaces only as a small footer under the
    /// bubble it produced (see `SpecialistFooterView`).
    private var navigationBar: some View {
        HStack(spacing: Theme.Spacing.md) {
            // Avatar
            Circle()
                .fill(Theme.Colors.accent.opacity(0.15))
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: "message.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text("Coach")
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Vital AI")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            Spacer()

            Button(action: vm.startNewChat) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            .accessibilityLabel("New chat")
            .opacity(vm.isOnboarding ? 0.0 : 1.0)
            // `isBusy`, not `isStreaming`: `startNewChat()` clears `rows`, and
            // it is guarded against running mid-handoff — so the button has to
            // dim then too, or it's a lit control that silently does nothing.
            .disabled(vm.isBusy)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.sm)
        .background(Theme.Colors.canvas)
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: Theme.Spacing.md) {
                    ForEach(vm.rows) { row in
                        switch row {
                        case .message(let msg):
                            MessageBubbleView(
                                message: msg,
                                specialistFooter: CoachViewPresentation.specialistFooter(for: msg.specialistMetadata)
                            )
                            .id(row.id)
                        case .assistantTurn(let turn):
                            AssistantTurnView(turn: turn)
                                .id(row.id)
                        }
                    }

                    if vm.showTypingIndicator {
                        TypingIndicatorView()
                            .id("typing")
                    }

                    // Invisible anchor to scroll to bottom
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 80
            } action: { _, nearBottom in
                if nearBottom {
                    // Re-pinning always applies, however the user (or a
                    // programmatic scroll) got back within range.
                    isScrolledNearBottom = true
                } else if scrollPhase == .interacting || scrollPhase == .decelerating {
                    // Only treat "moved away from bottom" as the user
                    // scrolling up while they're actually touching or still
                    // coasting from a touch. An animated programmatic scroll
                    // (the reveal-buffer catch-up, or a discrete-insertion
                    // scroll) also changes `visibleRect`, but isn't a real
                    // scroll-phase interaction — without this gate it used to
                    // get misread as the user scrolling away and unpin itself.
                    isScrolledNearBottom = false
                }
            }
            .onScrollPhaseChange { _, newPhase in
                scrollPhase = newPhase
            }
            .overlay(alignment: .bottom) {
                if !isScrolledNearBottom && vm.isStreaming {
                    Button {
                        isScrolledNearBottom = true
                        withAnimation(reduceMotion ? nil : Theme.Motion.snap) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    } label: {
                        Chip(text: "Jump to latest", icon: "arrow.down")
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, Theme.Spacing.sm)
                    .transition(.opacity)
                }
            }
            // Without an explicit animation tied to the condition, the
            // `.transition(.opacity)` above never plays — SwiftUI only
            // animates a transition when the view's appearance/disappearance
            // happens inside an animated state change.
            .animation(reduceMotion ? nil : Theme.Motion.snap, value: isScrolledNearBottom)
            // Fires once per reveal-buffer drain tick instead of on every
            // `rows` mutation — kills the per-token O(transcript) equality
            // check `onChange(of: vm.rows)` used to do ~60x/second.
            .onChange(of: vm.revealVersion) {
                scrollToBottomDuringReveal(proxy)
            }
            .onChange(of: vm.isStreaming) {
                scrollToBottomIfPinned(proxy)
            }
            .onChange(of: vm.isOpening) {
                scrollToBottomIfPinned(proxy)
            }
        }
    }

    private func scrollToBottomIfPinned(_ proxy: ScrollViewProxy) {
        guard isScrolledNearBottom else { return }
        withAnimation(reduceMotion ? nil : Theme.Motion.exit) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// Scroll path for the reveal buffer's per-tick growth. Deliberately no
    /// animation: the content growing underneath already supplies visual
    /// continuity, and re-triggering `Theme.Motion.exit` on top of that ~60
    /// times a second would self-interrupt and read as stutter rather than
    /// glue. Still gated on the pin so it never fights a deliberate scroll-up.
    private func scrollToBottomDuringReveal(_ proxy: ScrollViewProxy) {
        guard isScrolledNearBottom else { return }
        proxy.scrollTo("bottom", anchor: .bottom)
    }

    #if DEBUG
    /// Tiny top-left overlay with the last voice turn's derived latencies
    /// (spec §10 V1). Only appears when the app is launched with the
    /// `-VitalVoiceHUD` argument (Xcode scheme launch arguments, or a
    /// harness flag) — never shown otherwise, and compiled out of release
    /// builds entirely.
    @ViewBuilder
    private var voiceTurnHUD: some View {
        if ProcessInfo.processInfo.arguments.contains("-VitalVoiceHUD") {
            VStack {
                HStack {
                    voiceTurnHUDContent
                    Spacer()
                }
                Spacer()
            }
            .padding(.top, Theme.Spacing.xxxl)
            .padding(.leading, Theme.Spacing.md)
            .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private var voiceTurnHUDContent: some View {
        let durations = vm.lastVoiceTurnDurations
        VStack(alignment: .leading, spacing: 2) {
            Text("Voice turn")
                .font(.system(size: 10, weight: .bold))
            hudRow("endpoint_wait", durations?.endpointWait)
            hudRow("stt_wait", durations?.sttWait)
            hudRow("time_to_first_token", durations?.timeToFirstToken)
            hudRow("speech_end_to_first_audio", durations?.speechEndToFirstAudio)
        }
        .font(.system(size: 9, weight: .medium, design: .monospaced))
        .foregroundStyle(.white)
        .padding(6)
        .background(Color.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func hudRow(_ label: String, _ value: TimeInterval?) -> some View {
        HStack(spacing: 4) {
            Text(label)
            Spacer(minLength: 8)
            Text(value.map { String(format: "%.0fms", $0 * 1000) } ?? "–")
        }
    }
    #endif

    // MARK: - Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            if let errorMessage = vm.errorMessage {
                // Dismiss, not retry: the user's message is already in the
                // transcript *and* already persisted server-side (runCoach
                // inserts it before any model call, with no idempotency key),
                // so replaying the turn would double-write it and the user
                // would see their question twice on the next launch. There is
                // nothing to retry here — only a notice to clear. Sending
                // again is one deliberate tap.
                ErrorCard(
                    title: "Couldn't reach your coach",
                    message: errorMessage,
                    actionLabel: "Dismiss",
                    actionIcon: "xmark"
                ) {
                    vm.errorMessage = nil
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.top, Theme.Spacing.sm)
            }

            if vm.speaker.isSpeaking {
                stopSpeakingRow
            }

            if showMicPermissionHint {
                micPermissionHint
            }

            if showSuggestionChips {
                suggestionChipsRow
            }

            // V5: `CoachOrb` replaces the whole composer row while
            // conversation mode is active (spec §3.2's "72 pt in the Coach
            // tab"). At rest (fixtures included — `ScreenshotTests` never
            // enters conversation mode) `voice.mode` is always `.single`, so
            // this branch renders exactly today's composer, unchanged.
            if voice.mode == .conversation {
                CoachOrb(voice: voice, onEnd: { vm.endVoiceConversation() })
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Theme.Colors.canvas)
            } else {
                HStack(spacing: Theme.Spacing.sm) {
                    TextField("Message your coach…", text: composerText, axis: .vertical)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .tint(Theme.Colors.accentContent)
                        .lineLimit(1...5)
                        // While recording, the field mirrors the live transcript —
                        // typing over it would fight the mic. Also disabled while
                        // the recorded clip is being transcribed.
                        .disabled(voice.isRecording || isTranscribing)
                        .focused($composerFocused)
                        .onSubmit {
                            vm.send()
                        }

                    micButton

                    Button(action: {
                        if vm.isStreaming {
                            vm.stopGenerating()
                        } else {
                            vm.send()
                        }
                    }) {
                        Image(systemName: vm.isStreaming ? "stop.fill" : "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Theme.Colors.onAccent)
                            .frame(width: 32, height: 32)
                            .background(
                                Circle()
                                    .fill(
                                        (canSend || vm.isStreaming)
                                            ? Theme.Colors.accent
                                            : Theme.Colors.accent.opacity(0.3)
                                    )
                            )
                    }
                    // `canSend` already requires `!vm.isBusy`, so a bare
                    // `!canSend` would disable the button for the entire reply —
                    // a dead control during the most important moment. While
                    // streaming the button is always enabled (it's now the stop
                    // control); otherwise it falls back to the normal send gating.
                    //
                    // The second clause stays `isStreaming`, NOT `isBusy`: a
                    // specialist action isn't user-cancellable (`stopGenerating()`
                    // only ends a `send()`), so mid-handoff this must evaluate to
                    // disabled. Widening it to `isBusy` would flip it back to
                    // enabled — reintroducing exactly the dead tap target this
                    // pairing exists to prevent.
                    .disabled(!canSend && !vm.isStreaming)
                    .animation(Theme.Motion.micro, value: vm.isStreaming)
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
                .background(
                    Capsule()
                        .fill(Theme.Colors.card)
                        .overlay(
                            Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                        )
                )
                .shadow(color: Theme.Colors.cardShadow, radius: 1, x: 0, y: 1)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.md)
                .background(Theme.Colors.canvas)
            }
        }
    }

    /// Goal-aware conversation starters shown above the composer only until
    /// the user sends their first message this session (no `.message` row
    /// with role `.user` in `vm.rows` yet — cheaper than tracking a separate
    /// flag since `rows` is already the source of truth for the transcript).
    private var showSuggestionChips: Bool {
        !vm.rows.contains { row in
            if case .message(let msg) = row, msg.role == .user { return true }
            return false
        }
    }

    /// Roadmap 1.1 / ux-spec-v4 §10 row P1: Vital is a general fitness coach,
    /// not a marathon app — starter chips are picked from the user's diet
    /// goal (`CoachStarterChips`) instead of a fixed marathon-flavored list.
    private var suggestionPrompts: [String] {
        CoachStarterChips.chips(for: vm.userGoal)
    }

    private var suggestionChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(suggestionPrompts, id: \.self) { prompt in
                    Button {
                        vm.input = prompt
                        vm.send()
                    } label: {
                        Chip(text: prompt, isAccent: true)
                    }
                    .buttonStyle(.plain)
                    // These tap straight into `vm.send()`, so they follow the
                    // same busy state that guards it.
                    .disabled(vm.isBusy)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
        .scrollIndicators(.hidden)
    }

    /// The composer's displayed text. While a voice turn is live —
    /// `.listening` through `.transcribing` — it mirrors
    /// `voice.partialTranscript` directly (a `voice`-scoped change, not a
    /// `vm.input` one, so the ~60Hz stream of live-transcript tokens doesn't
    /// walk through `vm`'s heavier `objectWillChange`, spec §4's perf note).
    /// Anything typed while idle still writes straight to `vm.input`, and a
    /// completed voice turn lands there too the moment `send()` clears it.
    private var composerText: Binding<String> {
        Binding(
            get: { voice.state == .idle ? vm.input : voice.partialTranscript },
            set: { vm.input = $0 }
        )
    }

    /// `!vm.isBusy` rather than `!vm.isStreaming`: an accepted handoff streams
    /// the specialist's opening turn through the *action* path, which leaves
    /// `isStreaming` false the whole time. Gating on `isStreaming` alone left
    /// the composer lit and tappable during a handoff while `vm.send()` — which
    /// is guarded on the same busy state — silently dropped the tap.
    private var canSend: Bool {
        !vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !vm.isBusy
            && !voice.isRecording
            && !isTranscribing
    }

    // MARK: - Mic button

    /// Tap-to-talk, three states: idle → recording (tap again stops, or a
    /// watchdog auto-stops on silence/timeout) → transcribing (spinner,
    /// disabled, while the cloud upload resolves). Not yet asked → request
    /// permission only — recording starts on the next tap, never in the same
    /// instant the grant lands (starting the audio engine while the audio
    /// server is still spinning up after a first-time grant can abort inside
    /// AudioToolbox; LogMeal's two-step flow avoids this); denied → surface
    /// the inline Settings hint.
    ///
    /// Spec §3.1/§10 V3: starts on finger **down**, not tap-up, so a plain
    /// `Button` (touch-up-inside) won't do — its action is driven by a
    /// `DragGesture(minimumDistance: 0)` instead, whose `onChanged` fires on
    /// first touch. `isMicPressed` de-dupes the many `onChanged` callbacks a
    /// single held touch produces. Losing `Button` also loses its automatic
    /// accessibility button trait/action, so both are added back explicitly
    /// — VoiceOver's double-tap invokes `.accessibilityAction`, which calls
    /// the same `handleMicPress()`.
    ///
    /// **Gesture mapping (spec §3.1, V5):** tap = conversation mode, hold
    /// ≥ 300 ms = push-to-talk single turn, release to send. A fresh
    /// recording still always starts on touch-down (V3's latency win) —
    /// tentatively as `.conversation` — since the gesture isn't known to be
    /// a tap or a hold until release; a hold detected at release demotes it
    /// to `.single` right before `stopRecording()` (see
    /// `CoachVoiceController.demoteToSingleTurn()`). VoiceOver's
    /// `.accessibilityAction` calls `handleMicPress()` directly with no
    /// `onEnded` involved at all, so it never measures a hold — the
    /// controller's own VoiceOver check (spec §3.8) downgrades that
    /// `.conversation` intent to `.single` regardless.
    ///
    /// The visible circle stays 32pt, but the tappable/hit area is grown to
    /// Apple's 44×44 minimum via `.frame(minWidth:minHeight:)` — this is the
    /// most important control in the app. That adds ~12pt to this HStack's
    /// intrinsic width; the `TextField` next to it is flexible and simply
    /// shrinks to absorb it, and the send button (already 32pt, fixed) is
    /// unaffected other than shifting a few points right.
    private var micButton: some View {
        ZStack {
            Circle()
                .fill(voice.isRecording
                      ? Theme.Colors.alert
                      : Theme.Colors.accent.opacity(0.15))
                .frame(width: 32, height: 32)
            if isTranscribing {
                ProgressView()
                    .controlSize(.mini)
                    .tint(Theme.Colors.accentContent)
            } else {
                Image(systemName: voice.isRecording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(voice.isRecording ? Theme.Colors.onAccent : Theme.Colors.accentContent)
            }
        }
        .scaleEffect(voice.isRecording ? 1.08 : 1.0)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .opacity(isMicButtonDisabled ? 0.5 : 1.0)
        .allowsHitTesting(!isMicButtonDisabled)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isMicPressed else { return }
                    isMicPressed = true
                    let startingFresh = !isMicButtonDisabled && voice.state == .idle && !voice.isRecording
                    micPressStartedAt = startingFresh ? Date() : nil
                    handleMicPress()
                }
                .onEnded { _ in
                    isMicPressed = false
                    // Only a press that itself started a *new* recording
                    // (not one that stopped an already-in-flight one) can be
                    // a hold — `micPressStartedAt` is nil otherwise.
                    if let startedAt = micPressStartedAt, voice.mode == .conversation, voice.isRecording {
                        let held = Date().timeIntervalSince(startedAt) >= Self.pushToTalkHoldThreshold
                        if held {
                            voice.demoteToSingleTurn()
                            voice.stopRecording()
                        }
                    }
                    micPressStartedAt = nil
                }
        )
        .accessibilityElement()
        .accessibilityLabel(voice.isRecording ? "Stop recording" : "Talk to your coach")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { handleMicPress() }
        .ambient(Theme.Motion.pulse, value: voice.isRecording)
        .sensoryFeedback(Theme.Haptics.toggle, trigger: voice.isRecording)
        .sensoryFeedback(Theme.Haptics.turnEnd, trigger: voice.turnEndTrigger)
    }

    /// The hold threshold spec §3.1 maps to push-to-talk single turn (vs. a
    /// quick tap, which is conversation mode).
    private static let pushToTalkHoldThreshold: TimeInterval = 0.3

    /// `isBusy`: recording started mid-handoff would transcribe fine and
    /// then hand off to `send()`, which rejects it — the user would speak a
    /// whole message into a no-op. The `!isRecording` clause is unchanged,
    /// so stopping an in-progress recording always stays available.
    private var isMicButtonDisabled: Bool {
        (vm.isBusy && !voice.isRecording) || isTranscribing
    }

    /// A *fresh* recording (see `micButton`'s gesture) starts tentatively as
    /// `.conversation` — the touch-up handler there demotes it to `.single`
    /// if the press turns out to be a ≥300 ms hold. `.accessibilityAction`
    /// (VoiceOver) also routes through here with the same intended mode;
    /// the controller itself downgrades that to `.single` while VoiceOver
    /// is running (spec §3.8), so this never needs to check VoiceOver.
    private func handleMicPress() {
        guard !isMicButtonDisabled else { return }
        switch voice.permissionState {
        case .authorized:
            vm.toggleVoiceRecording(mode: .conversation)
        case .notDetermined:
            Task {
                await vm.requestVoicePermissions()
                if voice.permissionState != .authorized {
                    didAttemptDeniedMic = true
                }
            }
        case .denied:
            didAttemptDeniedMic = true
        }
    }

    private var showMicPermissionHint: Bool {
        didAttemptDeniedMic && voice.permissionState == .denied
    }

    private var micPermissionHint: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "mic.slash.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
            Text("Allow microphone and speech recognition in Settings to talk to your coach.")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer(minLength: Theme.Spacing.sm)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Settings")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.glassFill)
    }

    // MARK: - Stop-speaking row

    /// Shown above the input bar while the coach's reply is being read
    /// aloud; tapping it cancels speech immediately (the text keeps
    /// streaming/rendering either way).
    private var stopSpeakingRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
            Text("Speaking…")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
            Button { vm.speaker.stop() } label: {
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Stop")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(Theme.Colors.textPrimary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs)
                .background(Capsule().fill(Theme.Colors.glassFill))
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.canvas)
    }
}

// MARK: - Assistant turn

private struct AssistantTurnView: View {
    let turn: AssistantTurn

    private var isStreamingTurn: Bool { !turn.isFinished }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(turn.dataCards) { card in
                CoachDataCardView(viz: card.viz)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }

            // Order is conditional on whether prose has started. Before any
            // text has streamed in, the tool-call chip is the only thing
            // happening, so it stays above (where the empty bubble would be).
            // Once prose exists, a mid-turn tool call describes work
            // happening after what was just said, so the chip moves below it.
            if turn.text.isEmpty {
                statusChip
                proseBubble
            } else {
                proseBubble
                statusChip
            }
        }
    }

    @ViewBuilder
    private var statusChip: some View {
        if let status = turn.statusSummary {
            ToolCallActivityView(label: status, isChecking: turn.isChecking)
        }
    }

    @ViewBuilder
    private var proseBubble: some View {
        if !turn.text.isEmpty {
            MessageBubbleView(
                message: ChatMessage(id: turn.id, role: .assistant, text: turn.text),
                specialistFooter: CoachViewPresentation.specialistFooter(for: turn.persona),
                showsCaret: isStreamingTurn
            )
            .transition(.opacity)
        }
    }
}

// MARK: - Message bubble

private struct MessageBubbleView: View {
    let message: ChatMessage
    /// `nil` for a user/system message, or a non-Vital assistant message with
    /// no specialist contribution. Callers derive this themselves rather than
    /// the view reaching for `message.specialistMetadata` on its own — a
    /// still-streaming `AssistantTurn` carries its persona separately (that
    /// field is only populated on the persisted/restored `ChatMessage`), so
    /// `AssistantTurnView` and the plain-message row each compute it their
    /// own way (see `CoachViewPresentation.specialistFooter(for:)`).
    var specialistFooter: CoachViewPresentation.SpecialistFooter? = nil
    var showsCaret: Bool = false

    var body: some View {
        if message.role == .system {
            JoinedSystemRowView(text: message.text)
        } else {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                if message.role == .user { Spacer(minLength: 48) }

                VStack(alignment: message.role == .user ? .trailing : .leading, spacing: Theme.Spacing.xs) {
                    bubbleContent
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, Theme.Spacing.md)
                        .bubbleSurface(isUser: message.role == .user)
                        .fixedSize(horizontal: false, vertical: true)

                    if let specialistFooter {
                        SpecialistFooterView(footer: specialistFooter)
                    }
                }

                if message.role == .assistant { Spacer(minLength: 48) }
            }
        }
    }

    /// User bubbles are plain single-line-ish text; the coach reply renders
    /// block-level markdown (lists, paragraphs) via MarkdownText.
    @ViewBuilder
    private var bubbleContent: some View {
        if message.role == .user {
            Text(message.text.asMarkdown)
                .lineSpacing(3)
        } else {
            MarkdownText(markdown: message.text, showsCaret: showsCaret)
        }
    }
}

/// D4: one coach voice — every assistant bubble reads as Vital, regardless of
/// whether a specialist contributed (that's the footer's job now, not the
/// bubble surface). A white v3 card for the user, pale-lime for the coach.
private extension View {
    @ViewBuilder
    func bubbleSurface(isUser: Bool) -> some View {
        if isUser {
            background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.card)
            )
            .shadow(color: Theme.Colors.cardShadow, radius: 1, x: 0, y: 1)
        } else {
            background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.accentSoft)
            )
        }
    }
}

// MARK: - Specialist attribution footer

/// D4 (one coach voice): the specialist handoff cards and "Stay with …"
/// confirmations are gone — a specialist's contribution to a Vital reply now
/// surfaces only as this small, quiet footer under the bubble it produced.
/// Never spoken by `CoachSpeaker` (only `AssistantTurn.text`/`ChatMessage.text`
/// feed TTS), and not a tappable control — pure attribution.
private struct SpecialistFooterView: View {
    let footer: CoachViewPresentation.SpecialistFooter

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: footer.icon)
                .font(.system(size: 10, weight: .semibold))
            Text(footer.text)
        }
        .font(Theme.Typography.labelSmall)
        .foregroundStyle(Theme.Colors.textTertiary)
        .padding(.horizontal, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

private struct JoinedSystemRowView: View {
    let text: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Rectangle()
                .fill(Theme.Colors.specialistAccent.opacity(0.55))
                .frame(height: 1)
            Image(systemName: "figure.run")
                .foregroundStyle(Theme.Colors.specialistAccent)
            Text(text)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(CoachViewPresentation.joinedSystemRowLineLimit(for: dynamicTypeSize))
                .layoutPriority(1)
                .fixedSize(horizontal: !dynamicTypeSize.isAccessibilitySize, vertical: true)
            Rectangle()
                .fill(Theme.Colors.specialistAccent.opacity(0.55))
                .frame(height: 1)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Specialist presentation contract

enum CoachViewPresentation {
    /// D4 (one coach voice, specialists invisible behind it): a small footer
    /// rendered under a coach bubble a specialist contributed to. Never a
    /// speaker header, never a card — just quiet attribution.
    struct SpecialistFooter: Equatable {
        let icon: String
        let text: String
    }

    static func joinedSystemRowText(for persona: CoachPersonaSnapshot) -> String {
        "\(persona.title) joined."
    }

    static func joinedSystemRowLineLimit(for dynamicTypeSize: DynamicTypeSize) -> Int? {
        dynamicTypeSize.isAccessibilitySize ? nil : 1
    }

    /// Maps a specialist id (`SpecialistMessageMetadata.specialistId` /
    /// `CoachPersonaSnapshot.id`, from `lib/specialists/registry.ts`) to its
    /// footer copy. Unknown ids (a future specialist this build doesn't know
    /// about yet) fall back to a generic "Checked with a specialist" rather
    /// than showing nothing.
    static func specialistFooter(forSpecialistId id: String) -> SpecialistFooter {
        switch id {
        case "nutritionist":
            return SpecialistFooter(icon: "fork.knife", text: "Checked with your nutritionist")
        case "strength-coach":
            return SpecialistFooter(icon: "dumbbell.fill", text: "Checked with your strength coach")
        case "running-coach":
            return SpecialistFooter(icon: "figure.run", text: "Checked with your running coach")
        default:
            return SpecialistFooter(icon: "person.fill.checkmark", text: "Checked with a specialist")
        }
    }

    /// For a historical message restored from the server — `nil` when Vital
    /// answered directly (no specialist contributed).
    static func specialistFooter(for metadata: SpecialistMessageMetadata?) -> SpecialistFooter? {
        guard let metadata else { return nil }
        return specialistFooter(forSpecialistId: metadata.specialistId)
    }

    /// For a still-streaming (or just-finished) assistant turn — `nil` while
    /// `turn.persona` is Vital itself.
    static func specialistFooter(for persona: CoachPersonaSnapshot) -> SpecialistFooter? {
        guard persona.id != "vital" else { return nil }
        return specialistFooter(forSpecialistId: persona.id)
    }
}

// MARK: - Tool-call activity row

/// Inline, quiet indicator for the active backend work in an assistant turn.
/// Completed tool calls are intentionally not left behind as permanent chat
/// content; the data cards and answer carry the durable result.
private struct ToolCallActivityView: View {
    let label: String
    let isChecking: Bool

    var body: some View {
        HStack {
            if isChecking {
                HStack(spacing: Theme.Spacing.xs) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.textSecondary)
                    Text(label)
                        .font(Theme.Typography.labelSmall)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(Theme.Colors.glassFill)
                        .overlay(
                            Capsule()
                                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                        )
                )
            } else {
                Chip(text: label, icon: "checkmark")
            }

            Spacer()
        }
    }
}

// MARK: - Typing indicator

private struct TypingIndicatorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack {
            Group {
                if reduceMotion {
                    // `.phaseAnimator` self-drives regardless of any
                    // `.animation`/`.ambient` gating applied to it, so Reduce
                    // Motion must be handled by not attaching it at all —
                    // render the three dots statically instead.
                    dotsRow(activeIndex: nil)
                } else {
                    Color.clear
                        .phaseAnimator([0, 1, 2]) { _, phase in
                            dotsRow(activeIndex: phase)
                        } animation: { _ in
                            .easeInOut(duration: 0.4)
                        }
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.accentSoft)
            )

            Spacer()
        }
    }

    /// All three dots, scaled up at `activeIndex` (or all resting if `nil`).
    private func dotsRow(activeIndex: Int?) -> some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Theme.Colors.textSecondary)
                    .frame(width: 7, height: 7)
                    .scaleEffect(activeIndex == i ? 1.3 : 0.8)
            }
        }
    }
}

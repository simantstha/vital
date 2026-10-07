import SwiftUI
import UIKit

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
    /// Whether the calm empty-state anchor (mic glyph + one line of copy)
    /// belongs in the blank space below the opener bubble: only while the
    /// conversation is nothing but that opener (no user message sent yet —
    /// `showSuggestionChips` is already this view's existing signal for
    /// that), only once the opener bubble actually exists (`!vm.rows.isEmpty`
    /// — otherwise this would render above the typing indicator during
    /// load), and never while `CoachOrb` owns the composer for an active
    /// voice conversation, so the two never compete for the same space.
    private var showEmptyStateAnchor: Bool {
        !vm.rows.isEmpty && showSuggestionChips && voice.mode != .conversation
    }
    @FocusState private var composerFocused: Bool
    /// Guards the mic button's touch-down gesture (spec §3.1/§10 V3: start
    /// on finger down, not tap-up) so `DragGesture`'s repeated `onChanged`
    /// firings while a finger is held down only trigger the mic action once
    /// per press. Reset in `onEnded`.
    @State private var isMicPressed = false
    /// "Manage memory" (K3's receipt detail footer link) — presented as a
    /// sheet rather than a `NavigationLink` push since the Coach tab has no
    /// ambient `NavigationStack` of its own (unlike Profile, which
    /// `MemoryView`'s own doc comment assumes).
    @State private var showMemorySheet = false
    /// Set on touch-down only when that press actually starts a *new*
    /// recording (not one that stops an in-flight one) — the gesture
    /// mapping (spec §3.1, V5) reads it back at release to tell a quick tap
    /// (conversation mode) from a ≥300 ms hold (push-to-talk single turn).
    @State private var micPressStartedAt: Date? = nil
    /// Fires `pushToTalkHoldThreshold` after a fresh touch-down and, if the
    /// finger is still down then, recognises the press as a hold: calls
    /// `CoachVoiceController.beginHold()` right then (not at release) so
    /// auto-endpointing suspends the moment the hold is recognised — a
    /// pause mid-hold must never end the turn on its own (the bug this
    /// fixes: holding, talking, pausing mid-thought only sent the tail).
    /// Cancelled on release.
    @State private var holdRecognitionTask: Task<Void, Never>? = nil
    /// True once `holdRecognitionTask` has actually recognised this press as
    /// a hold — read at release to decide whether to call `stopRecording()`
    /// (push-to-talk semantics) or leave the turn running (a quick tap,
    /// which stays live as `.conversation` until it naturally endpoints).
    @State private var isHoldRecognized = false

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
                if vm.isCoachOffline && !vm.isOnboarding {
                    offlineBanner
                }
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
        .sheet(isPresented: $showMemorySheet) {
            NavigationStack {
                MemoryView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showMemorySheet = false }
                        }
                    }
            }
        }
        .toast(message: $vm.toastMessage)
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

    // MARK: - Offline banner

    /// Shown only when the coach load failed — the opener below is then the
    /// generic fallback, and this keeps that from reading as a healthy coach.
    private var offlineBanner: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.icloud")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.Colors.caution)
                .accessibilityHidden(true)
            Text(CoachViewModel.offlineBannerText)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.cautionSoft)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("coach.offlineBanner")
        .motionTransition(.fade)
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
                            AssistantTurnView(
                                turn: turn,
                                onUndoMeal: { vm.undoMealLog(id: $0) },
                                onScaleMeal: { id, factor in vm.scaleMealLog(id: id, factor: factor) },
                                onScaleMealItem: { id, food, grams in vm.scaleMealLogItem(id: id, food: food, grams: grams) },
                                onUndoMemory: { vm.undoMemoryFact(id: $0) },
                                onConfirmMemoryProposal: { vm.confirmMemoryProposal(factId: $0) },
                                onDismissMemoryProposal: { vm.dismissMemoryProposal(factId: $0) },
                                onManageMemory: { showMemorySheet = true }
                            )
                                .id(row.id)
                        }
                    }

                    if vm.showTypingIndicator {
                        TypingIndicatorView()
                            .id("typing")
                    }

                    if showEmptyStateAnchor {
                        CoachEmptyStateAnchor()
                            .padding(.top, Theme.Spacing.xxl)
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
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

            // Single-mode cloud-STT failure (spec: "Couldn't transcribe
            // that — try again"). Conversation mode surfaces the same
            // `voice.lastError` through `CoachOrb`'s caption instead — that
            // orb replaces this whole row while `mode == .conversation`, so
            // this and the caption never show at the same time.
            if voice.mode != .conversation, let voiceError = voice.lastError, case .transcriptionFailed(let diagnostic) = voiceError {
                ErrorCard(
                    title: "Couldn't transcribe that",
                    message: "Try again. (\(diagnostic))",
                    actionLabel: "Dismiss",
                    actionIcon: "xmark"
                ) {
                    voice.clearError()
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

            // V5: `CoachOrb` replaces the whole composer row once the press
            // that started the turn has lifted (spec §3.2's "72 pt in the Coach
            // tab"). At rest (fixtures included — `ScreenshotTests` never
            // enters conversation mode) `voice.mode` is always `.single`, so
            // this branch renders exactly today's composer, unchanged.
            // Waiting until the finger lifts (gated by `!isMicPressed`) keeps
            // the mic button mounted under the user's finger so its
            // `DragGesture` is not torn down during a hold — without this,
            // push-to-talk holds were never recognised and pauses ended the
            // turn abruptly.
            if Self.showsConversationOrb(mode: voice.mode, isMicPressed: isMicPressed) {
                CoachOrb(voice: voice, onEnd: { vm.endVoiceConversation() })
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Theme.Colors.canvas)
            } else {
                HStack(spacing: Theme.Spacing.sm) {
                    ZStack(alignment: .leading) {
                        TextField("Message your coach…", text: composerText, axis: .vertical)
                            .font(Theme.Typography.bodyMedium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .tint(Theme.Colors.accentContent)
                            .lineLimit(1...5)
                            // Disabled while recording (typing over a live
                            // turn would fight the mic) and while the
                            // recorded clip is being transcribed.
                            .disabled(voice.isRecording || isTranscribing)
                            .focused($composerFocused)
                            .onSubmit {
                                vm.send()
                            }
                            .opacity(isVoiceComposerActive ? 0 : 1)

                        // No live Apple words on screen (owner decision,
                        // spec `voice-cloud-only-stt`) — while a voice turn
                        // is live, this replaces the composer's text
                        // entirely with "Listening…"/"Transcribing…" plus a
                        // level meter driven by `voice.inputLevel`, instead
                        // of `voice.partialTranscript`.
                        if isVoiceComposerActive {
                            voiceListeningRow
                        }
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
                            .background(Circle().fill(Theme.Colors.accent))
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
                    // Same 0.5/1.0 muted-vs-lit convention `micButton` uses for
                    // its own disabled state just above — dims the whole button
                    // (icon and fill together) rather than only the circle, so an
                    // empty composer visibly reads as non-interactive instead of
                    // looking tappable. Layout position/size never changes, only
                    // opacity, so nothing shifts when it enables.
                    .opacity((canSend || vm.isStreaming) ? 1.0 : 0.5)
                    .animation(Theme.Motion.quick, value: vm.isStreaming)
                    .animation(Theme.Motion.quick, value: canSend)
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
        // The row clips at the trailing edge with no affordance that more
        // chips follow — a trailing fade reads as "scroll for more" the way
        // the leading edge (always fully opaque, nothing to hint there)
        // doesn't need to. Purely a rendering mask, so it's Reduce Motion
        // safe with nothing to disable.
        .mask(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 0.92),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
        )
    }

    /// The composer's displayed text. No live Apple words on screen (owner
    /// decision, spec `voice-cloud-only-stt`): unlike before, this never
    /// mirrors `voice.partialTranscript` — while a voice turn is live the
    /// `TextField` is hidden entirely behind `voiceListeningRow`, so this
    /// binding only ever needs `vm.input`. Apple recognition keeps running
    /// invisibly underneath (still driving endpointing), it's just never
    /// rendered. A completed voice turn lands in `vm.input` the moment
    /// `send()` clears it, same as before.
    private var composerText: Binding<String> {
        Binding(
            get: { vm.input },
            set: { vm.input = $0 }
        )
    }

    /// True while the composer's `TextField` should be replaced by
    /// `voiceListeningRow` — `.listening` (mic live) through `.transcribing`
    /// (cloud STT upload in flight). `.sending` isn't included: by then a
    /// final transcript already resolved and `send()` is about to clear
    /// `vm.input`, so there's nothing to hide behind a listening row for.
    private var isVoiceComposerActive: Bool {
        voice.state == .listening || voice.state == .transcribing
    }

    /// Replaces the composer's text entirely while a voice turn is live —
    /// spec `voice-cloud-only-stt` #1: a "Listening…"/"Transcribing…" label
    /// plus a simple live level meter driven by `voice.inputLevel`, no
    /// partial transcript text anywhere.
    private var voiceListeningRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(voice.state == .transcribing ? "Transcribing…" : "Listening…")
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textSecondary)
            if voice.state == .listening {
                VoiceLevelMeter(level: voice.inputLevel)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(voice.state == .transcribing ? "Transcribing" : "Listening")
    }

    /// `!vm.isBusy` rather than `!vm.isStreaming`: an accepted handoff streams
    /// the specialist's opening turn through the *action* path, which leaves
    /// `isStreaming` false the whole time. Gating on `isStreaming` alone left
    /// the composer lit and tappable during a handoff while `vm.send()` — which
    /// is guarded on the same busy state — silently dropped the tap.
    private var canSend: Bool {
        CoachViewModel.isSendableInput(vm.input)
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
    /// a tap or a hold until 300 ms have passed with the finger still down.
    /// `holdRecognitionTask` recognises the hold live, at the 300 ms mark —
    /// not only in hindsight at release — and calls
    /// `CoachVoiceController.beginHold()` right then: that both demotes to
    /// `.single` (same as the old `demoteToSingleTurn()`) AND suspends
    /// auto-endpointing, so a pause while the finger is still down can never
    /// end the turn on its own (see that method's doc comment for the bug
    /// this fixes). Release then just calls `stopRecording()` if the hold
    /// was recognised; a quick tap (never recognised as a hold) leaves the
    /// turn running as `.conversation` until it naturally endpoints.
    /// VoiceOver's `.accessibilityAction` calls `handleMicPress()` directly
    /// with no `onEnded`/hold-timer involved at all, so it never measures a
    /// hold — the controller's own VoiceOver check (spec §3.8) downgrades
    /// that `.conversation` intent to `.single` regardless.
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
                    isHoldRecognized = false
                    handleMicPress()

                    // Only a press that itself started a *new* recording can
                    // become a hold — `micPressStartedAt` is nil otherwise
                    // (e.g. this touch-down was the one that *stopped* an
                    // already-in-flight recording).
                    guard startingFresh else { return }
                    holdRecognitionTask?.cancel()
                    holdRecognitionTask = Task { @MainActor in
                        try? await Task.sleep(for: .seconds(Self.pushToTalkHoldThreshold))
                        guard !Task.isCancelled else { return }
                        // Still down, and still the same press that started
                        // this recording — recognise it as a hold right now.
                        guard isMicPressed, micPressStartedAt != nil else { return }
                        isHoldRecognized = true
                        voice.beginHold()
                    }
                }
                .onEnded { _ in
                    isMicPressed = false
                    holdRecognitionTask?.cancel()
                    holdRecognitionTask = nil
                    if isHoldRecognized {
                        // belt-and-braces in case beginHold() no-op'd
                        voice.demoteToSingleTurn()
                        voice.stopRecording()
                    }
                    isHoldRecognized = false
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

    /// The conversation orb replaces the composer only once the press that
    /// started the turn has lifted. Swapping it in at touch-down removed the
    /// mic button (and its hold gesture) from under the user's finger, so
    /// push-to-talk holds were never recognised and pauses ended the turn.
    nonisolated static func showsConversationOrb(mode: CoachVoiceController.ConversationMode, isMicPressed: Bool) -> Bool {
        mode == .conversation && !isMicPressed
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
    /// Wired to `CoachViewModel.undoMealLog(id:)` — kept as a plain closure
    /// (not a `vm` reference) so this view stays a pure function of `turn`,
    /// same as the rest of the file's row views.
    var onUndoMeal: (String) -> Void = { _ in }
    /// Wired to `CoachViewModel.scaleMealLog(id:factor:)` — the portion
    /// chips (½× · 1× · 1.5× · 2×). Same plain-closure rationale as
    /// `onUndoMeal` above.
    var onScaleMeal: (String, Double) -> Void = { _, _ in }
    /// Wired to `CoachViewModel.scaleMealLogItem(id:food:grams:)` — the
    /// per-item stepper sheet on one receipt row. Same plain-closure
    /// rationale as `onUndoMeal` above.
    var onScaleMealItem: (String, String, Int) -> Void = { _, _, _ in }
    /// Wired to `CoachViewModel.undoMemoryFact(id:)` — `MemorySavedChip`'s Undo.
    var onUndoMemory: (String) -> Void = { _ in }
    /// Wired to `CoachViewModel.confirmMemoryProposal(factId:)` —
    /// `MemoryProposalCard`'s "Remember".
    var onConfirmMemoryProposal: (String) -> Void = { _ in }
    /// Wired to `CoachViewModel.dismissMemoryProposal(factId:)` —
    /// `MemoryProposalCard`'s "Not now".
    var onDismissMemoryProposal: (String) -> Void = { _ in }
    /// Wired to `CoachView`'s memory sheet — the receipt detail's
    /// "Manage memory" link.
    var onManageMemory: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// K3: whether this turn's receipt is expanded in place.
    @State private var isReceiptExpanded = false

    private var isStreamingTurn: Bool { !turn.isFinished }

    /// Which of the working card / pill / nothing to show right now, per
    /// `CoachActivityLogic.presentation`. A running step's age only matters
    /// while it could still be within the 400 ms appear-gate or currently
    /// running, so `now` only needs to be live (ticking) in that window —
    /// see `activitySection`.
    private func activityPresentation(now: Date) -> CoachActivityLogic.Presentation {
        let running = turn.receiptRows.filter { !$0.isDone }
        let oldestAge = running.map { now.timeIntervalSince($0.startedAt) }.max() ?? 0
        return CoachActivityLogic.presentation(
            // Deliberately `receiptRows`, not `turn.hasActivity`: a turn
            // whose only tool call is a memory WRITE renders exclusively via
            // `memoryOpRows` (K4's chip/card) — an empty receipt pill would
            // otherwise flash in alongside it.
            hasActivity: !turn.receiptRows.isEmpty,
            hasRunningStep: !running.isEmpty,
            oldestRunningStepAge: oldestAge,
            hasProse: !turn.text.isEmpty,
            isFinished: turn.isFinished
        )
    }

    /// Whether the activity section needs a live clock right now — only
    /// while a step might still be running (so the elapsed counter ticks and
    /// the 400 ms gate can flip). Once prose starts or the turn finishes,
    /// the presentation is stable and a `TimelineView` would just waste
    /// cycles.
    private var activityNeedsLiveClock: Bool {
        turn.receiptRows.contains { !$0.isDone } && turn.text.isEmpty && !turn.isFinished
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(turn.dataCards) { card in
                CoachDataCardView(viz: card.viz)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }

            ForEach(turn.mealReceipts) { receipt in
                LogReceiptCard(
                    icon: "fork.knife",
                    title: "Logged \(MealReceiptRow.displayTitle(items: receipt.items, fallbackName: receipt.name))",
                    detail: receipt.detail,
                    timestamp: receipt.timestamp,
                    state: receipt.cardState,
                    onUndo: receipt.canUndo ? { onUndoMeal(receipt.id) } : nil,
                    onScale: { factor in onScaleMeal(receipt.id, factor) },
                    items: receipt.items.map {
                        LogReceiptCard.ItemRow(food: $0.food, grams: $0.grams, kcal: $0.kcal, confidence: $0.confidence)
                    },
                    onScaleItem: { food, grams in onScaleMealItem(receipt.id, food, grams) }
                )
                .accessibilityLabel(mealReceiptAccessibilityLabel(receipt))
                .accessibilityAction(named: "Undo") {
                    if receipt.canUndo { onUndoMeal(receipt.id) }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .leading)))
                .sensoryFeedback(Theme.Haptics.success, trigger: receipt.cardState) { _, new in
                    new == .undone
                }
            }

            // The activity section (working card → receipt pill/detail)
            // always renders above the prose bubble, whether or not text has
            // started streaming yet — the working card folds in place into
            // the pill as the answer starts, rather than jumping to the far
            // side of it (chat-activity-contract.md §4, K1/K2/K3). Memory
            // ops (K4) render alongside it, in the same relative order.
            memoryOpRows
            activitySection
            proseBubble
        }
    }

    /// K1 → K2 → K3: the working card while a step is running, folding into
    /// the receipt pill (optionally expanded in place) once prose starts or
    /// the turn finishes. `EmptyView` when the turn has no tool calls at
    /// all — chat-activity-contract.md §4.
    @ViewBuilder
    private var activitySection: some View {
        if activityNeedsLiveClock {
            TimelineView(.periodic(from: turn.workStartedAt ?? Date(), by: 0.1)) { context in
                activityContent(now: context.date)
            }
        } else {
            activityContent(now: Date())
        }
    }

    @ViewBuilder
    private func activityContent(now: Date) -> some View {
        switch activityPresentation(now: now) {
        case .none:
            EmptyView()
        case .workingCard:
            CoachWorkingCard(rows: turn.receiptRows, workStartedAt: turn.workStartedAt ?? now)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
        case .pill:
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                CoachReceiptPill(
                    rows: turn.receiptRows,
                    isExpanded: isReceiptExpanded,
                    onTap: { withAnimation(reduceMotion ? Theme.Motion.standard : Self.foldSpring) { isReceiptExpanded.toggle() } }
                )
                if isReceiptExpanded {
                    CoachReceiptDetail(rows: turn.receiptRows, onManageMemory: onManageMemory)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
            }
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
        }
    }

    /// The 320 ms working-card→pill fold spring (chat-activity-contract.md
    /// §4), at the house `dampingFraction: 0.8` every spring in this app uses.
    fileprivate static let foldSpring: Animation = .spring(response: CoachActivityLogic.foldSpringDuration, dampingFraction: 0.8)

    /// K4: one inline element per finished memory-write tool call, in call
    /// order — `MemorySavedChip` for `saved`/`updated`/`removed`,
    /// `MemoryProposalCard` for `proposed`.
    @ViewBuilder
    private var memoryOpRows: some View {
        ForEach(turn.memoryOpRows) { row in
            if let memory = row.memory {
                memoryOpView(for: memory)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .leading)))
            }
        }
    }

    @ViewBuilder
    private func memoryOpView(for memory: CoachMemoryOp) -> some View {
        if memory.op == .proposed, let factId = memory.factId {
            MemoryProposalCard(
                text: memory.text,
                onRemember: { onConfirmMemoryProposal(factId) },
                onNotNow: { onDismissMemoryProposal(factId) }
            )
        } else {
            MemorySavedChip(
                op: memory.op,
                text: memory.text,
                // Undo only ever applies to a `saved` write with a stable
                // factId — chat-activity-contract.md §2/§4.
                onUndo: memory.op == .saved ? memory.factId.map { factId in { onUndoMemory(factId) } } : nil
            )
        }
    }

    /// "Logged <name>, <kcal> kilocalories" per spec, with the receipt's
    /// current Undo state appended — overrides `LogReceiptCard`'s own generic
    /// label (which reads the raw `title`/`detail` strings) with this exact
    /// wording.
    private func mealReceiptAccessibilityLabel(_ receipt: MealReceiptRow) -> String {
        let base = "Logged \(receipt.name), \(receipt.kcal) kilocalories"
        switch receipt.cardState {
        case .undone:                    return "\(base), removed"
        case .undoing:                   return "\(base), removing"
        case .undoFailed(let message):   return "\(base), \(message)"
        case .normal, .pending:          return base
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
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = ChatCopy.copyableText(message.text)
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
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

// MARK: - K1: working card

/// "WORKING ON IT" — shown while a tool call is running and no prose has
/// streamed yet (chat-activity-contract.md §4/K1). Each row shows its kind
/// icon (memory tint vs. accent tint), a spinner while running, and its
/// summary line once done.
struct CoachWorkingCard: View {
    let rows: [ToolCallRow]
    let workStartedAt: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: workStartedAt, by: 1)) { context in
            VStack(alignment: .leading, spacing: 0) {
                header(elapsedSeconds: max(0, Int(context.date.timeIntervalSince(workStartedAt).rounded(.down))))
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    stepRow(row)
                        .padding(.vertical, Theme.Spacing.sm)
                        .overlay(alignment: .top) {
                            if index > 0 { hairline }
                        }
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .opacity.combined(with: .move(edge: .top)).animation(.easeOut(duration: CoachActivityLogic.stepAppearDuration))
                        )
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.xs)
        .padding(.bottom, Theme.Spacing.xs)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.card)
        )
        .shadow(color: Theme.Colors.cardShadow, radius: 8, x: 0, y: 2)
        .accessibilityElement(children: .combine)
    }

    private func header(elapsedSeconds: Int) -> some View {
        HStack {
            Text("WORKING ON IT")
                .font(Theme.Typography.labelSmall)
                .tracking(0.6)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
            Text("\(elapsedSeconds)s")
                .font(Theme.Typography.labelSmall.monospacedDigit())
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.vertical, Theme.Spacing.sm)
    }

    private var hairline: some View {
        Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
    }

    private func stepRow(_ row: ToolCallRow) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            stepIcon(row)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label)
                    .font(Theme.Typography.bodySmall)
                    .fontWeight(row.isDone ? .regular : .medium)
                    .foregroundStyle(row.isDone ? Theme.Colors.textSecondary : Theme.Colors.textPrimary)
                if row.isDone, let summary = row.summary, row.ok != false {
                    Text(summary)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            Spacer(minLength: 0)
            stepTrailing(row)
        }
    }

    private func stepIcon(_ row: ToolCallRow) -> some View {
        let isMemory = CoachActivityLogic.usesMemoryTint(row.resolvedKind)
        return Circle()
            .fill(isMemory ? Theme.Colors.memorySoft : Theme.Colors.accentSoft)
            .frame(width: 26, height: 26)
            .overlay(
                Image(systemName: CoachActivityLogic.icon(forKind: row.resolvedKind))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isMemory ? Theme.Colors.memory : Theme.Colors.accentContent)
            )
    }

    @ViewBuilder
    private func stepTrailing(_ row: ToolCallRow) -> some View {
        if row.isDone {
            Image(systemName: row.ok == false ? "exclamationmark.circle" : "checkmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(row.ok == false ? Theme.Colors.alert : Theme.Colors.positive)
        } else {
            ProgressView()
                .controlSize(.mini)
                .tint(Theme.Colors.textSecondary)
        }
    }
}

// MARK: - K2: receipt pill

/// The folded working card — a single tappable summary line
/// (chat-activity-contract.md §4/K2). Expands `CoachReceiptDetail` in place.
struct CoachReceiptPill: View {
    let rows: [ToolCallRow]
    let isExpanded: Bool
    var onTap: () -> Void = {}

    private var summary: String { CoachActivityLogic.pillSummary(forRows: rows) }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(summary)
                    .font(Theme.Typography.labelMedium)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: isExpanded ? "chevron.up" : "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .frame(minHeight: 36)
            .background(
                Capsule()
                    .fill(Theme.Colors.card)
                    .overlay(Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5))
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("coach.receiptPill")
        .accessibilityLabel("What I looked at: \(summary)")
        .accessibilityHint(isExpanded ? "Collapses the details" : "Shows the details")
    }
}

// MARK: - K3: receipt detail

/// The expanded receipt (chat-activity-contract.md §4/K3): every step with
/// its summary, memory quotes with the memory-tint leading rule, and a
/// "Manage memory" link to `MemoryView`.
struct CoachReceiptDetail: View {
    let rows: [ToolCallRow]
    var onManageMemory: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    stepRow(row)
                    ForEach(row.sources ?? [], id: \.text) { source in
                        sourceQuote(source)
                    }
                }
                .padding(.vertical, Theme.Spacing.sm)
                .overlay(alignment: .top) {
                    if index > 0 { hairline }
                }
            }
            footer
                .padding(.top, Theme.Spacing.sm)
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.card)
        )
        .shadow(color: Theme.Colors.cardShadow, radius: 8, x: 0, y: 2)
        .accessibilityIdentifier("coach.receiptDetail")
    }

    private var hairline: some View {
        Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
    }

    private func stepRow(_ row: ToolCallRow) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            iconBadge(for: row)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                if let summary = row.summary {
                    Text(summary)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: row.ok == false ? "exclamationmark.circle" : "checkmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(row.ok == false ? Theme.Colors.alert : Theme.Colors.positive)
        }
    }

    private func iconBadge(for row: ToolCallRow) -> some View {
        let isMemory = CoachActivityLogic.usesMemoryTint(row.resolvedKind)
        return Circle()
            .fill(isMemory ? Theme.Colors.memorySoft : Theme.Colors.accentSoft)
            .frame(width: 26, height: 26)
            .overlay(
                Image(systemName: CoachActivityLogic.icon(forKind: row.resolvedKind))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isMemory ? Theme.Colors.memory : Theme.Colors.accentContent)
            )
    }

    /// One quoted memory source — the memory-tint leading rule per
    /// chat-activity-contract.md §4.
    private func sourceQuote(_ source: CoachToolSource) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Theme.Colors.memory)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text("“\(source.text)”")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(source.date.map { "You told me · \(CoachActivityLogic.formattedSourceDate($0))" } ?? "You told me")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.leading, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.xs)
        }
        .background(Theme.Colors.memorySoft)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
    }

    private var footer: some View {
        HStack {
            Text("From Apple Health & your notes")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
            Button("Manage memory", action: onManageMemory)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
        }
        .padding(.top, Theme.Spacing.sm)
        .overlay(alignment: .top) { hairline }
    }
}

// MARK: - K4: memory chip / proposal card

/// "Noted: … · Undo" — a memory write already applied (`saved`), or its
/// quiet update/removal variants (chat-activity-contract.md §4). Undo is
/// hidden whenever `onUndo` is `nil` (no `factId`, or not a `saved` op).
struct MemorySavedChip: View {
    let op: CoachMemoryOpKind
    let text: String
    var onUndo: (() -> Void)? = nil

    /// The chip is a pure function of `op` — a successful Undo rewrites the
    /// owning `ToolCallRow.memory.op` to `.removed` in the model
    /// (`CoachViewModel.undoMemoryFact`), which flips this chip to "Removed"
    /// on the very next render, so no local echo state is needed here.
    private var verb: String {
        switch op {
        case .saved: return "Noted"
        case .updated: return "Updated"
        case .removed: return "Removed"
        case .proposed: return "Noted"
        }
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.memory)
            Text("\(verb): \(text)")
                .font(Theme.Typography.labelMedium)
                .fontWeight(.semibold)
                .foregroundStyle(Theme.Colors.memory)
                .lineLimit(2)
            if let onUndo {
                Text("·")
                    .foregroundStyle(Theme.Colors.textSecondary)
                Button("Undo", action: onUndo)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.memory)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Capsule().fill(Theme.Colors.memorySoft))
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Undo") { onUndo?() }
    }
}

/// "Save to memory?" (chat-activity-contract.md §4/K4) — Remember / Not now,
/// wired to the existing pending-facts confirm/dismiss API.
struct MemoryProposalCard: View {
    let text: String
    var onRemember: () -> Void = {}
    var onNotNow: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Circle()
                    .fill(Theme.Colors.memorySoft)
                    .frame(width: 26, height: 26)
                    .overlay(
                        Image(systemName: "doc.text")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.Colors.memory)
                    )
                Text("SAVE TO MEMORY?")
                    .font(Theme.Typography.labelSmall)
                    .tracking(0.6)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
            }
            Text(text)
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.semibold)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Theme.Spacing.sm) {
                Button(action: onRemember) {
                    Text("Remember")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Theme.Colors.accent)
                        .clipShape(Capsule())
                }
                Button(action: onNotNow) {
                    Text("Not now")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Theme.Colors.glassFill)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 1))
                }
            }
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.card)
        )
        .shadow(color: Theme.Colors.cardShadow, radius: 8, x: 0, y: 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Save to memory: \(text)")
    }
}

// MARK: - Empty-state anchor

/// Calm, centered filler for the large blank area a brand-new/single-opener
/// conversation otherwise leaves above the starter chips (see
/// `CoachView.showEmptyStateAnchor`). Pure presentation — no state, no
/// action — so it's Reduce Motion safe by construction; the only motion
/// attached to it is the one-shot `.appear` transition applied where it's
/// inserted into `messageList`.
private struct CoachEmptyStateAnchor: View {
    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Circle()
                .fill(Theme.Colors.accentSoft)
                .frame(width: 88, height: 88)
                .overlay(
                    Image(systemName: "mic.fill")
                        .font(.system(size: 32, weight: .medium))
                        .foregroundStyle(Theme.Colors.accentContent)
                )

            Text("Tap the mic and just talk — I'll keep the conversation going.")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Theme.Spacing.xxxl)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
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

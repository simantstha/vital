# What I learned building Vital

The long version of the summary in the [README](../README.md). Every point comes from something that happened in this repo.

**Working with AI coding agents (Claude Code, Codex)**

- **Rules beat reminders.** Anything I had to tell the agent twice went into a checked-in rules file ([AI_COMMON.md](../AI_COMMON.md)) shared by every tool: all changes through pull requests, no direct pushes to `main`, schema changes only as migration files. Two of those rules exist because of production incidents.
- **Split planning from typing.** The most capable model investigates, writes a spec and reviews the diff; a cheaper model makes the edit. It costs less, and the review step catches more because the reviewer did not write the code.
- **"Done" needs evidence.** Agents report success readily. The fix was process: a test that fails before the change and passes after, a screenshot run on every pull request, and checking that a merged commit is really on `main` (stacked pull requests showed as merged four times without reaching it).
- **Ground the brief in the code.** A plan written from memory of the codebase told an agent to refactor a path that lived in a different language. Now a brief names the exact files and is checked against them first.
- **Write the bug down before fixing it.** Each hard bug got a root-cause write-up in [docs/problems/](problems/) before any code changed. Several "obvious" fixes turned out to be wrong at that stage.

**Tool calling**

- **Give the model tools, not data.** Putting weeks of health data in the prompt was slow, expensive and made answers worse. With 22 narrow tools the model fetches only what the question needs, and the app can show the user what it looked at.
- **Tool results are part of the prompt.** A tool that returned raw records sent whole heart-rate curves and base64 meal photos back to the model. Results are now trimmed where the tool executes, so every caller benefits.
- **Tool descriptions are behaviour.** Whether the coach records an allergy, attributes a fact to a family member, or retracts a healed injury is decided by wording in the system prompt and tool schemas, which unit tests cannot see. A separate eval harness sends the real prompt and tools to the model and checks which tools it chooses ([docs/prompt-evals.md](prompt-evals.md)).
- **Never let the model claim an action it did not take.** The coach once said "Done" for a change that no tool had made. The fix was a real tool for the action, and a confirmation chip in the chat that is driven by the tool result instead of the model's sentence.
- **Bound the loop.** The chat loop stops after ten tool rounds, and handoff actions are idempotent by action id so a replay cannot apply the same change twice.

**Context management**

- **Cache the stable prefix, and keep it stable.** The system prompt and tool list are cached, and a single cache marker rolls forward through the tool loop so each round re-reads the earlier rounds from cache. Per-request details such as voice mode go in a separate uncached block, because one interpolated flag in the system prompt would invalidate the cache for every turn.
- **Decide what a conversation is.** History is cut at a four-hour gap or when the user taps "New chat", so yesterday's chat does not ride along forever.
- **Separate memory from history.** Long-lived facts live in the database with a source and a lifecycle, and are assembled into the prompt deterministically. The chat transcript is not the memory.
- **Stale context is worse than missing context.** A retracted fact that still reached one prompt kept shaping every analysis. Every reader of the fact table now filters on status.
- **Budget for thinking tokens.** Extended thinking consumed the output budget and truncated JSON mid-object. Structured calls now set thinking explicitly, chosen per model, because newer models reject the setting older ones need.

**Making LLM output trustworthy**

- **Validate, then fall back.** Every generated analysis passes a schema check and a grounding check on its numbers. On failure the user gets a plain correct summary, and the failure is logged with its reason. An earlier silent `catch` hid a complete outage for days.
- **Small models fail differently.** A cheaper model could not copy evidence tokens reliably and read `{{TOKEN}}` as a template placeholder. Model choice is now per task, and delimiters were changed to ones no model mistakes for template syntax.
- **Rules can make things worse.** A ban on digits, with "describe it qualitatively instead", made outputs longer and vaguer. Instructions need evals as much as code needs tests.

**Product and operations**

- **Absence is not zero.** The worst trust bugs were all the same bug: a missing reading shown as a measured value. Missing data now stays missing from the database to the screen.
- **One bad row should not stop everyone.** One user's revoked WHOOP grant aborted the sync pass for all users. Worker loops now separate "stop everything" errors (rate limits, outages) from "skip this row" errors.
- **Read denial is invisible on iOS.** HealthKit will not tell you a user declined read access, so adding a new data type needs its own re-prompt logic or existing installs quietly read nothing.
- **Polish is not validation.** I spent months improving the app before putting it in front of strangers. Next time, ten real users come before the tenth refactor.

**Cost and model choice**

- **Pick the model per task, and test the cheap one on the real task.** Chat, analyses and meal photos have different needs. The cheapest model failed the grounded-analysis task outright, so the saving was imaginary.
- **An environment variable can outvote your code.** The analysis model was set by a deploy secret that overrode the default in code. A "model switch" I shipped in code had no effect in production until the secret was removed.
- **Do not pay for analyses nobody will read.** A health-data backfill queued analyses for sessions that were weeks old. The worker now skips anything older than 48 hours before calling the model.
- **Watch the bill by day, not by month.** A month of production use cost about $33 in model calls, and $27 of that was one day that I never fully explained. A daily alert would have caught it the same afternoon.

## What I would do differently

1. **Put it in front of ten strangers in month one.** I built for six months on my own usage and a few friends. I still do not know whether anyone else wants it.
2. **Start with the migration ledger.** I used schema push until it caused an outage and then a truncated table. Committed migrations and a verifying runner should have been there before the first production deploy.
3. **Choose one home for each kind of data on day one.** Readings lived in two tables for a while, and different screens disagreed with each other.
4. **Log every swallowed error from the start.** The notification outage was a bare `catch {}`.
5. **Validate numbers after generation instead of constraining generation.** The evidence-token scheme worked, but checking each number the model wrote against the source data would have given the same guarantee with far less machinery. See the [case study](case-studies/notification-outage.md).
6. **Build fewer features.** Voice mode, specialist agents and a weekly review each took real time. One loop done well (sync, verdict, one honest explanation) would have been a better product.


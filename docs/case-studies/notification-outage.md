# Case study: five days of silent notification failures

**July 2026.** For about five days, every proactive notification in Vital failed: workout analyses, sleep analyses and morning briefs. Nothing crashed and nothing was logged. This is how it was found, misdiagnosed, half-fixed and then fixed.

## Background

After a workout or a night's sleep, a background worker asks Claude to write a short analysis. To stop the model inventing numbers, it is never shown raw values to copy. It receives *evidence tokens* (for example `⟦EVIDENCE_A⟧` for distance) and must write with those. A grounding step then validates the text and swaps each token for the real value. If grounding fails, the job retries, and eventually it is marked failed.

## What went wrong

**1. The failure was invisible.** The worker caught the grounding error in a bare `catch {}`. Jobs retried quietly until they reached a terminal failed state. The only symptom was that my phone stopped buzzing.

**2. The first diagnosis was wrong.** An earlier bug had involved a small model misreading tokens, so I assumed the model again and switched to a larger one through a deploy secret. Nothing changed, because the larger model failed the same way.

**3. The first real cause was a rule the model could not satisfy.** The validator required every token to be the last thing in its clause. The prompt also asked for four metrics in at most three sentences. Natural prose such as "a distance of ⟦A⟧ at a pace of ⟦B⟧" can never pass both. The fix relaxed the rule, removed the contradictory instructions and logged the swallowed error.

**4. That fix did not fix it.** Two days later I checked production instead of trusting the merge: every job since the deploy had still failed. Delivery was healthy, so the break was still in generation.

**5. There were two more causes underneath.**

- The validator kept one set of used tokens across the whole output and rejected any token that appeared twice. Good writing repeats the headline number. Two outputs that were identical except for one repeated token went from pass to fail.
- The small default model could not do the task at all. It made up token names outside the allowed range. The larger model passed reliably once the reuse rule was fixed.

## The fix

- Allow a token to be reused, and drop the "never repeat" lines from the prompt.
- Make the larger model the default for this task.
- **Deliver anyway.** If generation or grounding fails for any reason, store a plain fallback analysis built from the data and still send the notification. A model failure can now degrade the wording, but it cannot cause silence.

One more trap appeared on the way out: the model name was read from a deploy secret that overrode the default in code, so the new default did nothing until the secret was changed.

## What I took from it

- **A swallowed error is an outage waiting to be invisible.** Every catch now logs a reason, and failed jobs carry a failure category.
- **Verify the fix where the bug lived.** "Merged" and "deployed" are not "fixed". I only found causes two and three by counting real job outcomes after the first fix shipped.
- **Reproduce before theorising.** The wrong model hypothesis cost a day. Running the real generate-and-ground path against real inputs found the true cause in an hour.
- **Constraints on a model must be satisfiable together.** Each rule was reasonable alone. Nobody had checked that an output could pass all of them at once.
- **Design the failure path first.** The fallback should have existed before the clever part did.
- **The simpler design was available.** Letting the model write normally and then checking every number it wrote against the source data gives the same guarantee without tokens. I would build it that way next time.

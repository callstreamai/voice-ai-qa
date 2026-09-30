# Voice AI Call QA

Pulls a random sample of Bland calls, runs free checks on every one of them, and then has **Gemini listen to the actual recording**, but only for the calls you pick.

## How it works

1. **Sample (free).** Pick an account (or all accounts), a pathway (or all pathways), a date range and a sample size: 10, 50, 100, 250 or 500. The app pulls call metadata from Bland, shuffles it, and fetches transcripts until it has N matching calls.
2. **Triage (free).** Every sampled call gets a risk score based on:
   - possible cut-offs: the customer trails off ("…and") and the AI replies within 1.5s
   - slow AI replies (more than `SLOW_REPLY_SEC` seconds)
   - dead air in the audio (more than `DEAD_AIR_SEC` seconds of silence, found with ffmpeg)
   - talk-over, when the recording is stereo (the AI started speaking while the customer was still talking)
   - repeated questions, and frustration phrases ("I already told you", "real person", "let me finish"…)
3. **Deep review (on demand).** Tick calls (or click *Select top by risk*), then click **Deep review selected**. A confirmation shows the audio minutes and the estimated cost before anything runs.
   - **Gemini** gets the recording itself, along with the transcript and the measured timings. It listens for tone, sighs, impatience, talk-over, dead air and robotic or mispronounced delivery. It gives a timestamped verdict on each question: did we cut the customer off, did we understand context, were the pauses noticeable, did we forget something from earlier in the call, and was the customer annoyed with the AI (and why). It also tracks how the customer's tone changed over the call and suggests concrete fixes to the pathway or prompt. Clicking any timestamp jumps the audio player to that moment.
   - **Claude** (optional) gives a transcript-only second opinion.
   - **Hume** (optional) is kept for legacy use. Hume retired its public batch API in June 2026.

Spend is capped by `AUDIO_MAX_PER_REQUEST` (default 25 calls per click) and by `AUDIO_DAILY_CAP` (default 200 calls in any 24-hour window). Gemini costs roughly a cent or two per 5-minute call; set `GEMINI_COST_PER_MIN` so the on-screen estimate matches your pricing.

Get a Gemini key from Google AI Studio, then click **Test Gemini key** in the app to check it. Set `GEMINI_MODEL` to switch models.

## Configuration

See `.env.example`. Required: `DATABASE_URL`, `APP_PASSWORD`, and `BLAND_API_KEY` or `BLAND_ACCOUNTS`.

To sample across several accounts ("All accounts"), set:

```
BLAND_ACCOUNTS=[{"name":"Cherry Hill Nissan","key":"org_..."},{"name":"Store B","key":"org_..."}]
```

To log in, use any username with `APP_PASSWORD` as the password. The app refuses to run without `APP_PASSWORD`, because the recordings contain customer PII.

## Run locally

```
npm install
DATABASE_URL=postgres://... APP_PASSWORD=... BLAND_API_KEY=... npm start
```

`test/mock-apis.js` is a mock of Bland, Gemini, Hume and Anthropic for offline testing. Point `BLAND_API_BASE`, `GEMINI_API_BASE`, `HUME_API_BASE` and `ANTHROPIC_API_BASE` at `http://localhost:4010/{bland/v1,gemini,hume/v0,anthropic}`.

## Deploy

`render.yaml` sets up a Node web service on the Starter plan plus a Postgres database. Don't use the Free plan: free instances go to sleep, which would kill reviews that are still running.

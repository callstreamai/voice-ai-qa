# Voice AI Call QA

Pulls a random sample of Bland calls, runs free checks on every one of them, and then runs a paid audio review with **Hume** and **Claude**, but only on the calls you pick.

## How it works

1. **Sample (free).** Pick an account (or all accounts), a pathway (or all pathways), a date range and a sample size: 10, 50, 100, 250 or 500. The app pulls call metadata from Bland, shuffles it, and fetches transcripts until it has N matching calls.
2. **Triage (free).** Every sampled call gets a risk score based on:
   - possible cut-offs: the customer trails off ("…and") and the AI replies within 1.5s
   - slow AI replies (more than `SLOW_REPLY_SEC` seconds)
   - dead air in the audio (more than `DEAD_AIR_SEC` seconds of silence, found with ffmpeg)
   - talk-over, when the recording is stereo (the AI started speaking while the customer was still talking)
   - repeated questions, and frustration phrases ("I already told you", "real person", "let me finish"…)
3. **Deep review (on demand).** Tick calls (or click *Select top 10 by risk*), then click **Deep review selected**. A confirmation shows the audio minutes and the estimated Hume cost before anything runs.
   - **Hume** scores the customer's voice for annoyance, anger, disappointment and confusion, one utterance at a time. It also picks up sighs and groans, and whether the customer's mood got better or worse over the call.
   - **Claude** reads the transcript together with the timing checks and the Hume emotion timeline. It then gives a verdict, with timestamps, on each question: did we cut the customer off, did we understand context, were the pauses noticeable, did we forget something from earlier in the call, and was the customer annoyed with the AI (and why). It also lists what was missed and suggests concrete fixes to the pathway or prompt.

Hume spend is capped by `HUME_MAX_PER_REQUEST` (default 10 calls per click) and by `HUME_DAILY_CAP` (default 50 calls in any 24-hour window).

## Hume API note

Hume retired the public batch Expression Measurement API on **June 14, 2026**. It now offers "Tagger" and "Prosody" APIs by request. Use **Test Hume key** in the header to check your key:

- If your key works with the legacy `v0/batch/jobs` endpoint, the app works as-is.
- If Hume gave you access to a newer endpoint, set `HUME_API_BASE`. The adapter lives in `src/hume.js` if the request or response format changed.
- If your key is for EVI or TTS only, the test fails. Claude-only reviews still work.

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

`test/mock-apis.js` is a mock of Bland, Hume and Anthropic for offline testing. Point `BLAND_API_BASE`, `HUME_API_BASE` and `ANTHROPIC_API_BASE` at `http://localhost:4010/{bland/v1,hume/v0,anthropic}`.

## Deploy

`render.yaml` sets up a Node web service on the Starter plan plus a Postgres database. Don't use the Free plan: free instances go to sleep, which would kill reviews that are still running.

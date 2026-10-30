# Hyperframes Composition Brief: QuickBook (Variation 2: Speed-Run & Stress-Test)

## Objective
Create a fast-paced, high-tech video showcasing QuickBook's 2.4-second booking speed and zero-double-booking concurrency lock.

## Output
- Composition directory: `brag-output-v2-speed-test/composition/`
- Rendered video: `brag-output-v2-speed-test/brag.mp4`
- Format: vertical — 1080x1920 (9:16)
- Duration: 18 seconds (540 frames at 30 fps)

## Source Material
- Product: QuickBook (Telegram SaaS Appointment Platform)
- Key UI moments:
  - Big glowing stopwatch counting in milliseconds
  - Rapid 3-tap booking: `[✂️ Стрижка]` $\rightarrow$ `[💈 Алишер]` $\rightarrow$ `[15:30]`
  - Stop at `02.40s` with neon badge `⚡️ ЗАПИСЬ ОФОРМЛЕНА ЗА 2.4с`
  - 50 concurrent requests battle test: PostgreSQL advisory lock protects the slot
  - Stat callout: `Двойных записей: 0`

## Creative Direction
- Tone preset: `chaotic` / `app-store`
- Creative direction: Neon speed-run tech demo, high dopamine, punchy cuts
- Angle: Fastest way to book in the world, with enterprise-grade concurrency protection.
- Hook: Digital stopwatch counting down: "За сколько секунд клиент запишется к вам?"
- Outro: "Быстрее, чем набрать номер. QuickBook."

## Visual Identity
- Background: `#050811` (cyber dark)
- Accents: `#06b6d4` (electric cyan), `#10b981` (neon green), `#f43f5e` (racing red)
- Cards: `#0f172a` with glowing cyan borders
- Typography: High-contrast monospace & sans-serif

## Audio
- Audio role: high-energy electronic drive / tech pulse
- Music: `assets/music/music.mp3`
- SFX: stopwatch ticks, rapid clicks, bass drop on 2.4s lock

## Storyboard
1. Scene 1 (0.0s – 3.0s): Stopwatch timer countdown start.
2. Scene 2 (3.0s – 7.5s): Rapid 3-tap speedrun $\rightarrow$ timer stops at 02.40s.
3. Scene 3 (7.5s – 13.0s): 50 concurrent users stress test $\rightarrow$ 1 confirmed, 49 alternatives, 0 conflicts.
4. Scene 4 (13.0s – 15.5s): Owner power: `🔒 Блокировки` мастера в 1 клик.
5. Scene 5 (15.5s – 18.0s): Outro punchline + QuickBook badge.

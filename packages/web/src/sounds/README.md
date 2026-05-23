# Sound placeholders

The operator shell expects FLAC assets at these paths for lazy audio playback. `scripts/generate-sounds.mjs` creates short silent FLAC placeholders at build time with the local `ffmpeg` or `flac` encoder when available. If neither encoder exists, it writes tiny silent placeholder files so the paths still resolve.

These generated placeholders contain no third-party samples and are licensed as part of this repository.

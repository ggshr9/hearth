#!/usr/bin/env bash
# Fake yt-dlp for tests. Mimics the real binary's behavior just enough that
# fetchYouTubeTranscript can drive it — writes a canned .en.srt to the path
# the -o template specifies, then prints canned metadata JSON to stdout.
#
# The fake doesn't actually parse the URL; it always returns the same fixture
# content. Tests assert on that content.
set -e

# Find the -o template arg
OUT_TEMPLATE=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then OUT_TEMPLATE="$arg"; fi
  prev="$arg"
done

VIDEO_ID="dQw4w9WgXcQ"
SRT_PATH="${OUT_TEMPLATE//%(id)s/$VIDEO_ID}.en.srt"

cat > "$SRT_PATH" <<'EOF'
1
00:00:00,000 --> 00:00:03,500
We're no strangers to love

2
00:00:03,500 --> 00:00:07,000
You know the rules and so do I

3
00:00:07,000 --> 00:00:11,500
A full commitment's what I'm thinking of
EOF

cat <<EOF
{"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","uploader":"Rick Astley","duration":213}
EOF

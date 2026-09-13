Chinese Character Puzzle + Platform Core v1.0.0

Files:
- index.html
- Charadata.js
- platform/platform-core.js
- platform/platform-ui.css
- platform/supabase-config.js

GitHub Pages:
Upload all files/folders while keeping the same structure.
No new Supabase table is required if the shared tasks/task_results schema and Platform Core migrations are already installed.

Changes:
1. Added English completion certificate download (no student name).
2. Added task title, roster, deadline, taskId link generation.
3. Added class/name gate for roster tasks.
4. Added task status/deadline verification.
5. Added result submission to task_results (score=100, accuracy=100 on full completion; duration recorded).
6. Preserved legacy #g= links.
7. Fixed Generate Pinyin to actually use Charadata.js first, then built-in PINYINDB.

Recommended test:
Teacher preview -> task creation -> taskId opens -> roster selection -> full completion -> certificate -> Supabase task_results -> repeat attempt.

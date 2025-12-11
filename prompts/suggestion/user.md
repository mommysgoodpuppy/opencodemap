# Suggestion User Prompt

Based on the following information about a user's recent activity, suggest 1-3 broad code map topics that would be helpful to explore.
The most important information is the top of the navigation history, as it is the most recent activity. See if you can extrapolate what the user is working on or trying to learn, and suggest topics around that.

Navigation history (file/locations user has been viewing, most recent first):
{{recent_files}}

WARNING: it looks like you dont have much info. If you aren't extremely confident in your suggestions, just return 0 suggestions! You must not make vague suggestions based on git history alone!

Output a list of suggested code map topics and titles, format in JSON as:
[{
  "title": string, // short title for the codemap
  "subtitle": string, // short subtitle describing the scope; clearly delineate the scope of the map by specifying the beginning & end; the boundary of the territory to be mapped
  "starting_points": string[] // starting points paths or code symbols for exploration;  some points clearly within the territory to be mapped
}]

Requirements:
- Don't use tools, just output JSON
- Make titles actionable and specific. Usually this will be 0-2 suggestions.
- If your first suggestion covers everything you are confident the user is working on, don't suggest more.
- If there's a lot of diversity in navigation history, spread out suggestions to cover more territory
- If there is nothing interesting, just respond 0 suggestions!
- NEVER make multiple suggestions about the same topic
- **IMPORTANT: Always respond in {{language}}**

Example output:
```json
[{
  "title": "LinkedUser login and auth flow",
  "subtitle": "Frontend interaction, auth provider API call",
  "starting_points": ["path/to/file1.ts", "path/to/file2.py", "SomeClass"]
}, {
  "title": "Code completion flow",
  "subtitle": "user keyboard input, ML model invocation",
  "starting_points": ["path/to/file1.ts", "path/to/file2.py", "relevant_symbol_name"]
}]
```

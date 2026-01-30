<additional_metadata>
NOTE: Open files and cursor position may not be related to the user's current request. Always verify relevance before assuming connection.

The USER presented this request to you on {{ current_date }}.
</additional_metadata>
<user_request>
{{ detail_instruction }}

Now generate a codemap with the following object structure:

{
  "title": "string",
  "traces": [
    {
      "id": "string", // id of the trace: "1", "2", "3", ...
      "title": "string", // each trace should be 2-10 locations; don't split what could've been a single trace into multiple traces
      "description": "string", // short subtitle, discuss what service this is part of & how it relates to other traces
      "locations": [  // a sequence of 3-8 locations that map out control flow or data flow in order
        {
          "id": "string", // id of the location: 3a, 3b, 3c, 3d, 3e ... (if the trace id is 3)
          "lineContent": "string", // basic properties identifying the line
          "path": "string", // use absolute paths
          "lineNumber": number,
          "title": "string", // short title
          "description": "string" // subtitle
        }
      ]
    }
  ],
  "description": "string" // write a very brief description of the scope of the map, followed by a very brief sentence containing quick links to a few notable locations (reference them like [3b] or [6c])
}

Guidance: Pick meaningful, load-bearing lines whose line content is both significant and informative -- self-documenting. The goal is for the trace to act as a high-fidelity compression of a larger piece of logic. You should pick locations to highlight based on how much logical and structural significance they have. Which locations are "necessary and sufficient" to understand, if the goal is to understand the whole system?

IMPORTANT: Traces should tell stories -- they should answer questions of the form "what happens when" by tracing through the lines of code that get executed. Pick lines of code that actually do things. Imperative lines of code are preferred over definitions since they more clearly tell a story of "what happens when ...". In this spirit, avoid highlighting lines that merely define classes or functions; instead, pick the lines that call the functions or instantiate the classes!

IMPORTANT: Every hop between locations must correspond to a direct control or data transfer. Do not add conceptual edges like "enables", "supports", or "prepares". If an intermediate call/step is missing, include it (even if it’s in the same file). It is OK for multiple locations in a trace to come from the same file when that’s the truthful path.

IMPORTANT: If there are multiple disconnected systems that you need to cover in the map, make it clear in the map title and trace titles what system each trace is covering. This type of signposting and precise distinction betwene systems is critical to avoid talking about unrelated code in the same sentence.

Plan it out first -- for each trace, jot down the "what happens when" question that it aims to answer, and a few key imperative lines of code to highlight. Think clearly about what disconnected systems there may be, and make sure not to accidentally mix disconnected code in the same trace -- make a list of any disjoint systems there may be and what files they map to. A good hint: the full file path of source files is often a good clue as to what system it's part of.

Output format:
<PLAN>
your brainstorming goes here
</PLAN>
<CODEMAP>
codemap json content goes here
</CODEMAP>

Do not use tools. Do not use code fences. Only emit the JSON within the CODEMAP XML tags.

Always respond in the user's language.

</user_request>

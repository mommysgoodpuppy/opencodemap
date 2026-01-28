<additional_metadata>
NOTE: Open files and cursor position may not be related to the user's current request. Always verify relevance before assuming connection.

The USER presented this request to you on {{ current_date }}.
</additional_metadata>
<user_request>
Explore the code to collect all info needed to explain and answer the following prompt:
<user_prompt>{{ query }}</user_prompt>
{{ detail_level }}
Analyze the codebase and understand the structure. Trace upwards and downwards, digging into implementations as well as callsites, to provide a comprehensive answer.
	Trace across service boundaries and abstractions to find the core pieces of logic that make up the full code path.
When you are done, send a message like this: "I am done researching. 1 sentence summary: <summary of what you found>. Would you like to hear more?" and we will send follow up instructions.
	Always respond in the user's language.
</user_request>
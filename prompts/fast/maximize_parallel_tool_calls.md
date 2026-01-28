<maximize_parallel_tool_calls>
CRITICAL INSTRUCTION: For maximum efficiency, whenever you perform multiple operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like read_file, grep or codebase_search, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.
IMPORTANT: The primary tools are parallel-by-default. Use a single tool call with an array of targets (e.g., read_file with "files", list_dir with "directories", grep_search/find_by_name with "searches") instead of emitting multiple separate tool calls. A single-item array is valid for one target.
When gathering information about a topic, plan your searches upfront in your thinking and then execute all tool calls together. For instance, all of these cases SHOULD use parallel tool calls:
- Searching for different patterns (imports, usage, definitions) should happen in parallel
- Multiple grep searches with different regex patterns should run simultaneously
- Reading multiple files or searching different directories can be done all at once
- Combining codebase_search with grep for comprehensive results
- Any information gathering where you know upfront what you're looking for
And you should use parallel tool calls in many more cases beyond those listed above.
Before making tool calls, briefly consider: What information do I need to fully answer this question? Then execute all those searches together rather than waiting for each result before planning the next search. Most of the time, parallel tool calls can be used rather than sequential. Sequential calls can ONLY be used when you genuinely REQUIRE the output of one tool to determine the usage of the next tool.
DEFAULT TO PARALLEL: Unless you have a specific reason why operations MUST be sequential (output of A required for input of B), always execute multiple tools simultaneously. This is not just an optimization - it's the expected behavior. Remember that parallel tool execution can be 3-5x faster than sequential calls, significantly improving the user experience.
</maximize_parallel_tool_calls>

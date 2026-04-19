# Gemini prerequisites

- Install Gemini CLI so `gemini` is on your PATH, or set a custom Gemini binary path in DP Code Settings.
- Authenticate Gemini CLI before running DP Code:
  - Open `gemini` and choose Sign in with Google, or
  - configure `GEMINI_API_KEY`, or
  - configure Vertex AI credentials as documented by Gemini CLI.
- DP Code starts Gemini in ACP mode via `gemini --acp` for each Gemini-backed session.
- DP Code may inject a temporary `GEMINI_CLI_SYSTEM_SETTINGS_PATH` file so DP Code's Gemini thinking controls resolve to documented Gemini model aliases and budgets.
- Official docs:
  - Authentication: https://www.geminicli.com/docs/get-started/authentication/
  - ACP mode: https://www.geminicli.com/docs/cli/acp-mode/
  - Configuration: https://www.geminicli.com/docs/reference/configuration/

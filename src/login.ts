import { FigmaApiError } from "./api.js";

export interface LoginOptions {
  onlyToken?: boolean;
  onlyBrowser?: boolean;
  force?: boolean;
  tokenStdin?: boolean;
}
export interface LoginSteps {
  savedToken(): Promise<string | undefined>;
  validateToken(token: string): Promise<void>;
  requestToken(): Promise<string>;
  saveToken(token: string): Promise<void>;
  browserAuthenticated(): Promise<boolean>;
  loginBrowser(force: boolean): Promise<void>;
  report(message: string): void;
}
/** Resolve independently configured credentials; never equate a saved file with valid auth. */
export async function login(
  options: LoginOptions,
  steps: LoginSteps,
): Promise<void> {
  if (options.onlyToken && options.onlyBrowser)
    throw new Error("Choose either --only-token or --only-browser, not both.");
  if (options.onlyBrowser && options.tokenStdin)
    throw new Error("--token-stdin cannot be combined with --only-browser.");
  const errors: string[] = [];
  if (!options.onlyBrowser) {
    try {
      let valid = false;
      if (!options.force && !options.tokenStdin) {
        const token = await steps.savedToken();
        if (token) {
          try {
            await steps.validateToken(token);
            valid = true;
          } catch (error) {
            if (
              !(error instanceof FigmaApiError) ||
              ![401, 403].includes(error.status)
            )
              throw error;
            steps.report(
              "Saved API token is invalid, expired or missing validation scope; configure a replacement.",
            );
          }
        }
      }
      if (valid)
        steps.report("API token is already valid — skipping token setup.");
      else {
        const token = (await steps.requestToken()).trim();
        if (!token) throw new Error("Token cannot be empty.");
        await steps.validateToken(token);
        await steps.saveToken(token);
        steps.report("API token validated and saved.");
      }
    } catch (error) {
      errors.push(
        "API token: " +
          (error instanceof Error ? error.message : "setup failed"),
      );
    }
  }
  if (!options.onlyToken) {
    try {
      if (!options.force && (await steps.browserAuthenticated()))
        steps.report(
          "Browser session is already valid — skipping browser login.",
        );
      else {
        await steps.loginBrowser(!!options.force);
        steps.report("Browser session saved.");
      }
    } catch (error) {
      errors.push(
        "Browser: " + (error instanceof Error ? error.message : "setup failed"),
      );
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

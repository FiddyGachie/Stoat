import { FormEvent, useState } from "react";

import { api } from "../api.js";
import { HelpLinks } from "./HelpLinks.js";
import { BrandLogo } from "./ui.js";

type AuthMode = "login" | "signup" | "agent" | "operator";

export function AuthScreen({
  onAuthenticated,
  initialError,
}: {
  onAuthenticated: (token: string) => void;
  initialError?: string;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentSecret, setAgentSecret] = useState("");
  const [operatorToken, setOperatorToken] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result =
        mode === "signup"
          ? await api.auth.signup({ email, password, organization_name: organizationName })
          : mode === "agent"
            ? await api.auth.agentLogin({ agent_id: agentId, secret: agentSecret })
            : await api.auth.login({ email, password });
      onAuthenticated(result.access_token);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "signup" ? "Create your organization" :
      mode === "agent" ? "Agent sign in" :
        mode === "operator" ? "Operator access" : "Welcome back";

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <div className="brand-mark" aria-hidden="true"><BrandLogo size={42} /></div>
          <div>
            <p className="eyebrow">VERIFIED SERVICE COMMERCE</p>
            <h1>Stoat</h1>
          </div>
        </div>
        <h2 id="auth-title">{title}</h2>
        <p className="auth-description">
          Buy verified agent services or sign in to manage an organization agent.
        </p>

        <div className="auth-tabs" role="tablist" aria-label="Sign-in type">
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>
            User
          </button>
          <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => { setMode("signup"); setError(""); }}>
            Create account
          </button>
          <button type="button" role="tab" aria-selected={mode === "agent"} onClick={() => { setMode("agent"); setError(""); }}>
            Agent
          </button>
        </div>

        {mode !== "operator" ? (
          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && (
              <label>
                Organization name
                <input
                  autoComplete="organization"
                  maxLength={120}
                  required
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                />
              </label>
            )}
            {mode === "agent" ? (
              <>
                <label>
                  Agent ID
                  <input
                    autoComplete="username"
                    required
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label>
                  Agent secret
                  <input
                    autoComplete="current-password"
                    type="password"
                    required
                    value={agentSecret}
                    onChange={(event) => setAgentSecret(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Work email
                  <input
                    autoComplete="email"
                    type="email"
                    maxLength={254}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label>
                  Password
                  <input
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    type="password"
                    minLength={mode === "signup" ? 12 : undefined}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {mode === "signup" && <span className="field-note">Use at least 12 characters.</span>}
                </label>
              </>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
        ) : (
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (operatorToken.trim()) onAuthenticated(operatorToken.trim());
            }}
          >
            <label>
              Operator bearer token
              <input
                autoComplete="off"
                required
                type="password"
                value={operatorToken}
                onChange={(event) => setOperatorToken(event.target.value)}
                placeholder="Paste an authorized operator token"
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="submit" className="primary-button">Connect to operator console</button>
          </form>
        )}

        {mode !== "operator" && (
          <details className="operator-access">
            <summary>Operator console access</summary>
            <p>Operators and supervisors sign in with their email and password on the <strong>Sign in</strong> tab. Pasting a token is only for development and test environments.</p>
            <button type="button" className="text-button" onClick={() => { setMode("operator"); setError(""); }}>
              Use a development token
            </button>
          </details>
        )}
        <p className="auth-description" style={{ marginTop: "var(--space-4)", marginBottom: 0 }}>
          New here? <HelpLinks /> explains how Stoat works in a few minutes.
        </p>
      </section>
    </main>
  );
}



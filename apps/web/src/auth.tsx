import type { ReactNode } from "react";
import { SignInButton, SignedIn, SignedOut, useAuth, useUser } from "@clerk/clerk-react";
import { useEffect, useMemo, useState } from "react";
import { completeCliLogin, getApiBaseUrl, setApiAuthTokenProvider } from "./api";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? "";
const isLocalHost =
  typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname);
const cliCommandPrefix = isLocalHost ? "pnpm dev:cli --" : "pl";

export function CliLoginPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const loginCode = params.get("code");
  const deviceId = params.get("deviceId");
  const deviceName = params.get("deviceName");

  return (
    <div className="min-h-dvh bg-gz-0 px-5 py-10 text-t1">
      <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center gap-6">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-t3">Promptreel Cloud</p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-balance">Connect this machine</h1>
          <p className="text-sm leading-7 text-t2">
            Sign in with GitHub to connect your local Promptreel daemon to your hosted account.
          </p>
        </div>

        {!clerkPublishableKey ? (
          <AuthCard>
            <p className="text-sm leading-7 text-t2">
              Clerk is not configured yet. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> for this hosted app first.
            </p>
          </AuthCard>
        ) : !loginCode || !deviceId ? (
          <AuthCard>
            <p className="text-sm leading-7 text-t2">
              This login link is missing the device handshake details. Re-run <code>pl login</code> to generate a fresh
              link.
            </p>
          </AuthCard>
        ) : (
          <>
            <AuthCard>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-t3">Machine</p>
                <p className="text-sm font-medium text-t1">{deviceName || deviceId}</p>
                <p className="text-xs text-t3">{deviceId}</p>
              </div>
            </AuthCard>

            <SignedOut>
              <AuthCard>
                <div className="space-y-4">
                  <p className="text-sm leading-7 text-t2">
                    Continue with GitHub to authorize this machine. Once you finish, the CLI will pick up the connection
                    automatically.
                  </p>
                  <SignInButton mode="modal">
                    <button
                      type="button"
                      className="inline-flex items-center rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black/90"
                    >
                      Continue to sign in
                    </button>
                  </SignInButton>
                </div>
              </AuthCard>
            </SignedOut>

            <SignedIn>
              <CliLoginApprovalCard
                loginCode={loginCode}
                deviceId={deviceId}
                deviceName={deviceName}
              />
            </SignedIn>
          </>
        )}
      </div>
    </div>
  );
}

export function ClerkApiBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setApiAuthTokenProvider(() => getToken());
    return () => setApiAuthTokenProvider(null);
  }, [getToken]);

  return null;
}

export function CloudViewerGate(props: { children: ReactNode }) {
  return (
    <>
      <SignedIn>{props.children}</SignedIn>
      <SignedOut>
        <div className="min-h-dvh bg-gz-0 px-5 py-10 text-t1">
          <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center gap-6">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-t3">Promptreel Cloud</p>
              <h1 className="text-3xl font-semibold tracking-[-0.03em] text-balance">Sign in to view your prompts</h1>
              <p className="text-sm leading-7 text-t2">
                Connect with GitHub to load your synced Promptreel history from the hosted service.
              </p>
            </div>
            <AuthCard>
              <div className="space-y-4">
                <p className="text-sm leading-7 text-t2">
                  Once you sign in, Promptreel will load the prompt history uploaded from your linked local machine.
                </p>
                <SignInButton mode="modal">
                  <button
                    type="button"
                    className="inline-flex items-center rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black/90"
                  >
                    Continue with GitHub
                  </button>
                </SignInButton>
              </div>
            </AuthCard>
          </div>
        </div>
      </SignedOut>
    </>
  );
}

function CliLoginApprovalCard(props: {
  loginCode: string;
  deviceId: string;
  deviceName: string | null;
}) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [status, setStatus] = useState<"linking" | "linked" | "error">("linking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setStatus("linking");
      setError(null);
      try {
        const sessionToken = await getToken();
        if (!sessionToken) {
          throw new Error("Clerk session token is unavailable.");
        }

        await completeCliLogin(
          {
            loginCode: props.loginCode,
            deviceId: props.deviceId,
            deviceName: props.deviceName,
          },
          sessionToken,
          {
            email: user?.primaryEmailAddress?.emailAddress ?? null,
            name: user?.fullName ?? user?.username ?? null,
            avatarUrl: user?.imageUrl ?? null,
          }
        );

        if (cancelled) {
          return;
        }
        setStatus("linked");
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(nextError instanceof Error ? nextError.message : "Unable to connect this machine right now.");
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [getToken, props.deviceId, props.deviceName, props.loginCode, user?.fullName, user?.imageUrl, user?.primaryEmailAddress?.emailAddress, user?.username]);

  return (
    <AuthCard>
      {status === "linking" ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-t1">Linking your machine…</p>
          <p className="text-sm leading-7 text-t2">
            Promptreel is connecting this browser session to the local CLI handshake.
          </p>
        </div>
      ) : null}

      {status === "linked" ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-t1">This machine is connected.</p>
          <p className="text-sm leading-7 text-t2">
            Promptreel stored the cloud link for this machine and will use <code>{getApiBaseUrl()}</code> for future
            Promptreel Cloud requests.
          </p>
          <div className="rounded-2xl border border-brd bg-gz-1 px-4 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-t3">Next steps</p>
            <div className="mt-3 space-y-3 text-sm text-t2">
              <p>Back in your terminal, start the cloud sync daemon. It will do the initial upload and keep watching for changes.</p>
              <div className="space-y-2 font-mono text-[13px] text-t1">
                <div className="rounded-xl border border-brd bg-white px-3 py-2">{cliCommandPrefix} start</div>
                <div className="rounded-xl border border-brd bg-white px-3 py-2">{cliCommandPrefix} whoami</div>
                <div className="rounded-xl border border-brd bg-white px-3 py-2">{cliCommandPrefix} sync bootstrap</div>
              </div>
              <p className="text-xs leading-6 text-t3">
                Local-only development still uses <code>pnpm dev</code>, <code>pnpm dev:web</code>, or{" "}
                <code>pnpm dev:daemon</code>.
              </p>
            </div>
          </div>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => window.location.assign("/")}
              className="inline-flex items-center rounded-full border border-brd bg-white px-4 py-2 text-sm font-medium text-t1 transition hover:bg-gz-1"
            >
              Go to Promptreel
            </button>
          </div>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-red">Connection failed.</p>
          <p className="text-sm leading-7 text-t2">{error ?? "Unable to complete this CLI login."}</p>
        </div>
      ) : null}
    </AuthCard>
  );
}

function AuthCard(props: { children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-brd bg-white px-6 py-6 shadow-[0_18px_60px_-30px_rgba(17,24,39,0.2)]">
      {props.children}
    </div>
  );
}

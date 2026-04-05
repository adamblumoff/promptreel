import { ClerkProvider, useClerk, useUser } from "@clerk/clerk-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ClerkApiBridge, CloudViewerGate } from "./auth";
import { IS_CLOUD_VIEWER_MODE, VIEWER_MODE } from "./runtime-mode";
import "./styles.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
const isHostedViewer =
  IS_CLOUD_VIEWER_MODE
  && typeof window !== "undefined"
  && !window.location.pathname.startsWith("/cli-login");

function AppRoot() {
  return (
    <React.StrictMode>
      <App viewerMode={VIEWER_MODE} />
    </React.StrictMode>
  );
}

function AuthenticatedAppRoot() {
  const { isSignedIn, user } = useUser();
  const { signOut } = useClerk();

  const account = isSignedIn
    ? {
        label: user?.fullName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress ?? "Signed in",
        sublabel: user?.primaryEmailAddress?.emailAddress ?? null,
        avatarUrl: user?.imageUrl ?? null,
        canSignOut: true,
        onSignOut: () => void signOut({ redirectUrl: window.location.origin }),
      }
    : {
        label: "Not signed in",
        sublabel: "Local mode",
        avatarUrl: null,
        canSignOut: false,
      };

  return (
    <React.StrictMode>
      <App viewerMode={VIEWER_MODE} account={account} />
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  clerkPublishableKey ? (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <ClerkApiBridge />
      {isHostedViewer ? (
        <CloudViewerGate>
          <AuthenticatedAppRoot />
        </CloudViewerGate>
      ) : (
        <AuthenticatedAppRoot />
      )}
    </ClerkProvider>
  ) : (
    <AppRoot />
  )
);

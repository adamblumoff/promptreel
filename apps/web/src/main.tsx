import { ClerkProvider } from "@clerk/clerk-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ClerkApiBridge, CloudViewerGate } from "./auth";
import "./styles.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
const isHostedViewer =
  typeof window !== "undefined"
  && !["127.0.0.1", "localhost"].includes(window.location.hostname)
  && !window.location.pathname.startsWith("/cli-login");

function AppRoot() {
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  clerkPublishableKey ? (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <ClerkApiBridge />
      {isHostedViewer ? (
        <CloudViewerGate>
          <AppRoot />
        </CloudViewerGate>
      ) : (
        <AppRoot />
      )}
    </ClerkProvider>
  ) : (
    <AppRoot />
  )
);

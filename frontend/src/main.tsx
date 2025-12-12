import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import "./index.css";
import "./observability";
import App from "./App.tsx";

const ErrorFallback = () => (
  <div className="error-fallback">
    <h1>Something went wrong</h1>
    <p>Please try again or send a quick report so we can investigate.</p>
    <button type="button" onClick={() => Sentry.showReportDialog()}>
      Send Feedback
    </button>
  </div>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />} showDialog>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);

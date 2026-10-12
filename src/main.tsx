import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No StrictMode: its double-mount would draw the score twice into the same element.
createRoot(document.getElementById("root")!).render(<App />);

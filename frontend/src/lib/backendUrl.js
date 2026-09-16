// Leave unset for the same-origin production/Compose deployment.
// Set VITE_BACKEND_URL=http://localhost:8080 to use the LB from the Vite dev server.
export const backendUrl = import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.MODE === "development" ? "http://localhost:5001" : "");

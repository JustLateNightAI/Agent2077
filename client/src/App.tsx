import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { useEffect, useState, createContext, useContext } from "react";
import { apiRequest } from "./lib/queryClient";
import { getAgentName } from "@/lib/useAgentName";

// Pages
import LoginPage from "./pages/login";
import ChatPage from "./pages/chat";
import SettingsPage from "./pages/settings";
import AppStorePage from "./pages/app-store";
import SkillsPage from "./pages/skills";
import BenchmarkPage from "./pages/benchmark";
import AnalyticsPage from "./pages/analytics";
import ConsolePage from "./pages/console";
import MemoryPage from "./pages/memory";
import NotFound from "./pages/not-found";
import WorkspacePage from "./pages/workspace";
import TasksPage from "./pages/tasks";
import SelfDevPage from "./pages/self-dev";
import ImageGalleryPage from "./pages/image-gallery";
import Sidebar from "./components/sidebar";

// Auth context
interface AuthState {
  authenticated: boolean;
  username: string | null;
  token: string | null;
  login: (token: string, username: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  authenticated: false,
  username: null,
  token: null,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── Theme ───────────────────────────────────────────────────────────

type ThemeValue = "cyberpunk" | "professional" | "lofi";

/** Read the active theme from the server settings store and expose all settings globally. */
async function fetchThemeSetting(): Promise<ThemeValue> {
  try {
    const res = await fetch("/api/settings", { credentials: "include" });
    if (!res.ok) return "cyberpunk";
    const data = await res.json();
    // v16.40: expose full settings object so client-side handlers (e.g. paste threshold) can read them
    (window as any).__AGENT2077_SETTINGS__ = data;
    document.title = data["agent.name"] || "Agent2077";
    const t = data?.theme;
    if (t === "professional" || t === "lofi") return t;
    return "cyberpunk";
  } catch {
    return "cyberpunk";
  }
}

/** Apply a theme to the document root element. */
function applyTheme(theme: ThemeValue) {
  const root = document.documentElement;
  // All themes currently use dark mode
  root.classList.add("dark");
  // Set data-theme — Professional and Lofi get their own attribute;
  // Cyberpunk uses the default :root / .dark variables (no data-theme needed)
  if (theme === "professional" || theme === "lofi") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

function initTheme() {
  // Apply default (cyberpunk/dark) immediately to avoid flash, then
  // load the real setting asynchronously
  applyTheme("cyberpunk");
  fetchThemeSetting().then(applyTheme);
}

/** Call this whenever the theme setting changes (e.g. from SettingsPage). */
export function setTheme(theme: ThemeValue) {
  // Persist to server via PATCH /api/settings
  fetch("/api/settings", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  }).catch(() => {});
  applyTheme(theme);
}

/**
 * The Chat page is always mounted but visually hidden when on other tabs.
 * This preserves streaming state, plan progress, and partial responses
 * so nothing is lost if the user clicks to App Store and back.
 */
function AuthenticatedApp() {
  const [location] = useLocation();
  const isChatRoute = location === "/" || location.startsWith("/chat");
  const isWorkspaceRoute = location.startsWith("/workspace");

  // Extract conversation ID from chat route
  const chatMatch = location.match(/^\/chat\/(\d+)$/);
  const conversationId = chatMatch ? chatMatch[1] : undefined;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-hidden relative">
        {/* Chat is always mounted, just hidden when on other pages */}
        <div className={`absolute inset-0 ${isChatRoute ? "z-10 visible" : "z-0 invisible"}`}>
          <ChatPage conversationId={conversationId} />
        </div>

        {/* Other pages render on top when active */}
        {!isChatRoute && (
          <div className="absolute inset-0 z-10 overflow-auto">
            <Switch>
              <Route path="/workspace" component={WorkspacePage} />
              <Route path="/workspace/:id" component={WorkspacePage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/apps" component={AppStorePage} />
              <Route path="/skills" component={SkillsPage} />
              <Route path="/benchmark" component={BenchmarkPage} />
              <Route path="/analytics" component={AnalyticsPage} />
              <Route path="/console" component={ConsolePage} />
              <Route path="/memory" component={MemoryPage} />
              <Route path="/tasks" component={TasksPage} />
              <Route path="/self-dev" component={SelfDevPage} />
              <Route path="/images" component={ImageGalleryPage} />
              <Route component={NotFound} />
            </Switch>
          </div>
        )}
      </main>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; username: string | null; token: string | null }>({
    authenticated: false,
    username: null,
    token: null,
  });
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    initTheme();
    // Check if already authenticated (cookie-based)
    fetch("/api/auth/check", { credentials: "include" })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.authenticated) {
          setAuth({ authenticated: true, username: data.username, token: null });
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const login = (token: string, username: string) => {
    setAuth({ authenticated: true, username, token });
  };

  const logout = () => {
    fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setAuth({ authenticated: false, username: null, token: null });
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-primary animate-pulse-glow text-xl font-mono">
          {(() => {
            const n = getAgentName();
            if (n === "Agent2077") return <><span>AGENT</span><span style={{color:"hsl(var(--accent))"}}>2077</span></>;
            return <span>{n.toUpperCase()}</span>;
          })()}
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ ...auth, login, logout }}>
        <Router hook={useHashLocation}>
          {auth.authenticated ? <AuthenticatedApp /> : <LoginPage />}
        </Router>
        <Toaster />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

export default App;

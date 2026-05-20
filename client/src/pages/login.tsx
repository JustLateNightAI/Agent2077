import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "../App";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Login failed");
        return;
      }

      const data = await res.json();
      login(data.token, data.username);
      // Force a page reload to ensure auth state propagates
      window.location.reload();
    } catch (err: any) {
      setError("Connection failed. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo / Title */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-mono font-bold tracking-tight">
            <span className="text-primary glow-cyan">AGENT</span>
            <span className="text-accent glow-pink">2077</span>
          </h1>
          <p className="text-xs text-muted-foreground font-mono tracking-widest uppercase">
            Local AI Agent Platform
          </p>
        </div>

        <Card className="border-glow">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm text-center text-muted-foreground">Sign In</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoFocus
                  data-testid="input-username"
                />
              </div>
              <div className="space-y-2">
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  data-testid="input-password"
                />
              </div>

              {error && (
                <p className="text-xs text-destructive" data-testid="text-error">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || !username || !password}
                data-testid="button-login"
              >
                {loading ? "Authenticating..." : "Enter"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-[10px] text-muted-foreground font-mono">
          Default credentials: Agent2077 / Agent2077
        </p>
      </div>
    </div>
  );
}

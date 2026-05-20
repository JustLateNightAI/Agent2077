import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Home, ArrowLeft } from "lucide-react";

export default function NotFound() {
  const [, navigate] = useLocation();

  return (
    <div
      className="flex flex-col items-center justify-center h-full select-none"
      data-testid="not-found-page"
    >
      {/* Glitchy 404 display */}
      <div className="relative mb-6 text-center">
        <div
          className="text-[80px] leading-none font-mono font-bold opacity-10 absolute -top-2 left-0 right-0 text-primary"
          aria-hidden="true"
        >
          404
        </div>
        <div className="text-[80px] leading-none font-mono font-bold text-primary relative z-10"
          style={{ textShadow: "0 0 20px hsl(190 95% 50% / 0.6), 0 0 40px hsl(190 95% 50% / 0.3)" }}
        >
          404
        </div>
      </div>

      {/* Logo */}
      <div className="font-mono text-lg font-bold mb-2">
        <span className="text-primary">AGENT</span>
        <span style={{ color: "hsl(330 85% 60%)" }}>2077</span>
      </div>

      <p className="text-sm text-muted-foreground mb-1">Route not found in the grid.</p>
      <p className="text-xs text-muted-foreground mb-8 font-mono opacity-60">
        ERR_NEURAL_PATH_UNDEFINED
      </p>

      {/* Decorative scan line */}
      <div className="w-48 h-px bg-gradient-to-r from-transparent via-primary to-transparent mb-8 opacity-50" />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.history.back()}
          data-testid="button-go-back"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Go Back
        </Button>
        <Button
          size="sm"
          onClick={() => navigate("/")}
          data-testid="button-go-home"
        >
          <Home className="w-3.5 h-3.5 mr-1" /> Home
        </Button>
      </div>
    </div>
  );
}

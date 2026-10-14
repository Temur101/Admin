import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Lock, AlertTriangle } from "lucide-react";
import { useAuth } from "../context/AuthContext.js";
import { ApiError } from "../api/client.js";
import { Button } from "../components/common/Button.js";
import { Input } from "../components/common/Input.js";
import { Alert } from "../components/common/Alert.js";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Пожалуйста, заполните логин и пароль");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await login({ email: email.trim(), password });
      navigate("/dashboard");
    } catch (err: unknown) {
      if (err instanceof ApiError && err.statusCode === 429) {
        setError("Слишком много попыток входа (лимит превышен). Пожалуйста, подождите 15 минут перед следующей попыткой.");
      } else {
        const msg = err instanceof Error ? err.message : "Ошибка авторизации";
        if (
          msg.includes("429") ||
          msg.toLowerCase().includes("rate limit") ||
          msg.toLowerCase().includes("too many requests")
        ) {
          setError("Слишком много попыток входа. Пожалуйста, подождите 15 минут перед следующей попыткой.");
        } else {
          setError(msg || "Неверный логин или пароль");
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4 relative overflow-hidden">
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md space-y-6 z-10">
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 items-center justify-center text-white shadow-lg shadow-indigo-500/20 mb-2">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Вход в панель управления</h1>
          <p className="text-xs text-slate-400">Платформа Telegram SaaS (LeadCatch & QuickBook)</p>
        </div>

        <div className="bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6">
          {error && (
            <Alert type="error" title="Ошибка входа">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email или Логин супер-админа"
              type="text"
              name="email"
              autoComplete="username"
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <Input
              label="Пароль"
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full mt-2"
              isLoading={isLoading}
              icon={<Lock className="h-4 w-4" />}
            >
              Войти в админку
            </Button>
          </form>
        </div>

        <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500/70" />
          <span>Доступ ограничен для владельца платформы</span>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-800 p-8 shadow-xl border border-slate-700 text-center">
        <h1 className="text-2xl font-bold text-white mb-2">LeadCatch & QuickBook</h1>
        <p className="text-sm text-slate-400 mb-6">Административная панель управления платформой</p>
        <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-1.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Ядро платформы инициализировано
        </div>
      </div>
    </div>
  );
}

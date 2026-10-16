import { useState } from "react";
import { UnsavedChangesProvider } from "../../context/UnsavedChangesContext.js";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";

export function AdminLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <UnsavedChangesProvider>
      <div className="flex min-h-screen bg-ui-page text-ui-text">
        <Sidebar isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar onMenuClick={() => setMenuOpen(true)} />
          <main className="flex-1 p-4 sm:p-6 xl:p-8 overflow-y-auto">
            <div className="max-w-7xl mx-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </UnsavedChangesProvider>
  );
}

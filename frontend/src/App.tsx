import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import Layout from "./components/Layout";
import ConversationsPage from "./pages/ConversationsPage";
import CustomersPage from "./pages/CustomersPage";
import HomePage from "./pages/HomePage";
import ImportPage from "./pages/ImportPage";
import LoginPage from "./pages/LoginPage";
import OrdersPage from "./pages/OrdersPage";
import PaymentsPage from "./pages/PaymentsPage";
import ProductsPage from "./pages/ProductsPage";
import QuotesPage from "./pages/QuotesPage";
import ServicesPage from "./pages/ServicesPage";
import AiPage from "./pages/AiPage";
import WhatsAppPage from "./pages/WhatsAppPage";
import SettingsPage from "./pages/SettingsPage";

function Protected({ children, perm }: { children: JSX.Element; perm?: string[] }) {
  const { user, loading, can } = useAuth();
  if (loading) return <main className="center"><p>Cargando…</p></main>;
  if (!user) return <Navigate to="/login" replace />;
  if (perm && !perm.some(can)) return <p className="error">No tiene permisos para ver esta sección.</p>;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/conversaciones" element={<Protected perm={["conversations.read_all", "conversations.read_assigned"]}><ConversationsPage /></Protected>} />
        <Route path="/clientes" element={<Protected perm={["customers.read"]}><CustomersPage /></Protected>} />
        <Route path="/productos" element={<Protected perm={["catalog.read"]}><ProductsPage /></Protected>} />
        <Route path="/productos/importar" element={<Protected perm={["catalog.write"]}><ImportPage /></Protected>} />
        <Route path="/cotizaciones" element={<Protected perm={["quotes.read"]}><QuotesPage /></Protected>} />
        <Route path="/pedidos" element={<Protected perm={["orders.read"]}><OrdersPage /></Protected>} />
        <Route path="/pagos" element={<Protected perm={["payments.read"]}><PaymentsPage /></Protected>} />
        <Route path="/servicios" element={<Protected perm={["catalog.read"]}><ServicesPage /></Protected>} />
        <Route path="/whatsapp" element={<Protected perm={["whatsapp.read"]}><WhatsAppPage /></Protected>} />
        <Route path="/ia" element={<Protected perm={["ai.manage"]}><AiPage /></Protected>} />
        <Route path="/ajustes" element={<Protected perm={["settings.read"]}><SettingsPage /></Protected>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

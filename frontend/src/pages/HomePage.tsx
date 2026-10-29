import { useAuth } from "../auth/AuthContext";

export default function HomePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <section className="card">
        <h1>Sesión iniciada</h1>
        <p><strong>{user.name}</strong> ({user.email})</p>
        <p>Roles: {user.roles.join(", ") || "—"}</p>
        <p>Permisos: {user.permissions.length}</p>
        <p className="muted">Etapa 3: clientes, productos, servicios, conversaciones y ajustes. WhatsApp e IA llegan en las Etapas 4 y 5.</p>
      </section>
  );
}

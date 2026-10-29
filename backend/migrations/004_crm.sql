-- Clientes, contactos, conversaciones, etiquetas, notas, mensajes (lectura hasta la Etapa 4) e historial de estados.

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  email      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_email_idx ON customers (lower(email));
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       text,
  address     text NOT NULL,
  reference   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id);

-- Identidad de WhatsApp. En la Etapa 4 se añadirá el vínculo con la sesión.
CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164   text NOT NULL UNIQUE,
  wa_jid       text UNIQUE,
  display_name text,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_customer_idx ON contacts (customer_id);
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tags (code, name) VALUES
  ('PRODUCTO', 'Producto'), ('SERVICIO', 'Servicio'), ('GARANTIA', 'Garantía'), ('COTIZACION', 'Cotización'),
  ('PEDIDO', 'Pedido'), ('POSVENTA', 'Posventa'), ('INDECISO', 'Indeciso'), ('REQUIERE_HUMANO', 'Requiere humano');

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_human', 'closed')),
  control_mode     text NOT NULL DEFAULT 'ai' CHECK (control_mode IN ('ai', 'human', 'paused')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  state            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at  timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Una sola conversación abierta por contacto.
CREATE UNIQUE INDEX conversations_one_open_per_contact ON conversations (contact_id) WHERE status <> 'closed';
CREATE INDEX conversations_list_idx ON conversations (status, assigned_user_id, last_message_at DESC);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_tags (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE TABLE internal_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX internal_notes_conv_idx ON internal_notes (conversation_id, created_at DESC);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id    text,
  body             text,
  sent_by          text NOT NULL CHECK (sent_by IN ('customer', 'ai', 'user')),
  sent_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'received',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_wa_id_uq ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at DESC);

CREATE TABLE status_history (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  field       text NOT NULL,
  from_value  text,
  to_value    text,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_history_entity_idx ON status_history (entity_type, entity_id, changed_at DESC);

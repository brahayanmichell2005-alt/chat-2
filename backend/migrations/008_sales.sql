-- Etapa 6A: cotizaciones, pedidos y pagos. Los importes se calculan en el servidor (numeric, nunca float).

INSERT INTO permissions (code) VALUES ('quotes.discount'), ('orders.confirm') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('quotes.discount', 'orders.confirm') WHERE r.code IN ('admin', 'supervisor')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'orders.write' WHERE r.code = 'agent'
ON CONFLICT DO NOTHING;

CREATE SEQUENCE quote_code_seq;
CREATE SEQUENCE order_code_seq;
CREATE SEQUENCE payment_code_seq;

CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE DEFAULT ('COT-' || lpad(nextval('quote_code_seq')::text, 6, '0')),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_send', 'sent', 'accepted', 'rejected', 'expired', 'converted')),
  valid_until     timestamptz NOT NULL,
  notes           text,
  conditions      text,
  subtotal        numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  discount_total  numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  extra_total     numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_total >= 0),
  total           numeric(12,2) NOT NULL CHECK (total >= 0),
  reject_reason   text,
  send_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  sent_at         timestamptz,
  accepted_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (total = subtotal - discount_total + extra_total)
);
CREATE INDEX quotes_customer_idx ON quotes (customer_id, status);
CREATE INDEX quotes_status_valid_idx ON quotes (status, valid_until);
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quote_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  line_no     integer NOT NULL,
  item_type   text NOT NULL CHECK (item_type IN ('product', 'service')),
  product_id  uuid REFERENCES products(id) ON DELETE RESTRICT,
  service_id  uuid REFERENCES services(id) ON DELETE RESTRICT,
  description text NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  discount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total  numeric(12,2) NOT NULL CHECK (line_total >= 0),
  CHECK ((item_type = 'product' AND product_id IS NOT NULL AND service_id IS NULL) OR (item_type = 'service' AND service_id IS NOT NULL AND product_id IS NULL)),
  CHECK (line_total = qty * unit_price - discount),
  UNIQUE (quote_id, line_no)
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE DEFAULT ('PED-' || lpad(nextval('order_code_seq')::text, 6, '0')),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  quote_id        uuid UNIQUE REFERENCES quotes(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'preparing', 'completed', 'cancelled')),
  subtotal        numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  discount_total  numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  extra_total     numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_total >= 0),
  total           numeric(12,2) NOT NULL CHECK (total >= 0),
  delivery_terms  text,
  cancel_reason   text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (total = subtotal - discount_total + extra_total)
);
CREATE INDEX orders_customer_idx ON orders (customer_id, status);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no     integer NOT NULL,
  item_type   text NOT NULL CHECK (item_type IN ('product', 'service')),
  product_id  uuid REFERENCES products(id) ON DELETE RESTRICT,
  service_id  uuid REFERENCES services(id) ON DELETE RESTRICT,
  description text NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  discount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total  numeric(12,2) NOT NULL CHECK (line_total >= 0),
  CHECK ((item_type = 'product' AND product_id IS NOT NULL AND service_id IS NULL) OR (item_type = 'service' AND service_id IS NOT NULL AND product_id IS NULL)),
  CHECK (line_total = qty * unit_price - discount),
  UNIQUE (order_id, line_no)
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE DEFAULT ('PAG-' || lpad(nextval('payment_code_seq')::text, 6, '0')),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'PEN' CHECK (currency = 'PEN'),
  method        text NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'yape', 'plin', 'tarjeta_pos', 'otro')),
  reference     text,
  evidence_ref  text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'verified', 'rejected', 'refunded')),
  reason        text,
  registered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id, status);
CREATE INDEX payments_status_idx ON payments (status, created_at DESC);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

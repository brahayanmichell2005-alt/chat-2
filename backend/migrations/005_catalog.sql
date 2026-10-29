-- Catálogo de productos, servicios, inventario e importaciones.

CREATE TABLE product_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  parent_id  uuid REFERENCES product_categories(id) ON DELETE RESTRICT,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_categories_name_uq ON product_categories (lower(name));
INSERT INTO product_categories (name) VALUES
  ('Routers y conectividad'), ('Repetidores y Wi-Fi'), ('Cables y cableado'), ('Computadoras y componentes'),
  ('Periféricos y accesorios'), ('Herramientas e instalación'), ('Videovigilancia'), ('Otros');

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL,
  name            text NOT NULL,
  description     text,
  category_id     uuid NOT NULL REFERENCES product_categories(id) ON DELETE RESTRICT,
  brand           text,
  model           text,
  price           numeric(12,2) NOT NULL CHECK (price >= 0),
  cost            numeric(12,2) CHECK (cost >= 0),
  stock_on_hand   integer NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  stock_reserved  integer NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  stock_min       integer NOT NULL DEFAULT 0 CHECK (stock_min >= 0),
  warranty_months integer NOT NULL DEFAULT 0 CHECK (warranty_months >= 0),
  specs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_urls      text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_uq ON products (upper(sku));
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_search_trgm ON products USING gin ((coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(model,'')) gin_trgm_ops);
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inventory_movements (
  id            bigserial PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  type          text NOT NULL CHECK (type IN ('initial', 'import', 'adjustment', 'sale_reserve', 'sale_release', 'sale_out')),
  qty           integer NOT NULL CHECK (qty <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  ref_type      text,
  ref_id        text,
  reason        text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product_idx ON inventory_movements (product_id, created_at DESC);
-- Evita registrar dos veces el mismo movimiento de un mismo origen.
CREATE UNIQUE INDEX inventory_movements_ref_uq ON inventory_movements (ref_type, ref_id, type, product_id) WHERE ref_id IS NOT NULL;

CREATE TABLE service_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX service_categories_name_uq ON service_categories (lower(name));
INSERT INTO service_categories (name) VALUES
  ('Instalación y configuración de Wi-Fi'), ('Configuración de routers y repetidores'), ('Cableado estructurado y de red'),
  ('Redes locales'), ('Formateo e instalación de sistemas operativos'), ('Instalación de programas'),
  ('Diagnóstico y mantenimiento'), ('Reparaciones y soporte técnico'), ('Otros servicios');

CREATE TABLE services (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL,
  name                text NOT NULL,
  category_id         uuid NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  description         text,
  price_type          text NOT NULL DEFAULT 'quote' CHECK (price_type IN ('fixed', 'quote', 'inspection')),
  base_rate           numeric(12,2) CHECK (base_rate >= 0),
  requires_inspection boolean NOT NULL DEFAULT false,
  est_minutes         integer CHECK (est_minutes > 0),
  conditions          text,
  requirements        text,
  warranty_days       integer NOT NULL DEFAULT 0 CHECK (warranty_days >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (price_type <> 'fixed' OR base_rate IS NOT NULL)
);
CREATE UNIQUE INDEX services_code_uq ON services (upper(code));
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text NOT NULL CHECK (entity IN ('products')),
  status     text NOT NULL CHECK (status IN ('previewed', 'applied', 'cancelled')),
  mode       text NOT NULL CHECK (mode IN ('insert_only', 'upsert')),
  filename   text,
  summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE TABLE import_errors (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  column_name text,
  message     text NOT NULL
);
CREATE INDEX import_errors_job_idx ON import_errors (job_id, row_number);

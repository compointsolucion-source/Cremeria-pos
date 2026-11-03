-- Facturación: el negocio hace la factura en el SAT o en su programa y SUBE el PDF y el XML.
-- El sistema lee el XML (folio fiscal, RFC del cliente y total) y el cliente la descarga
-- en facturar.html con su folio + RFC, o con el enlace (folio + clave) que se le manda por WhatsApp.
ALTER TABLE facturacion_solicitudes
  ADD COLUMN IF NOT EXISTS factura_pdf BYTEA,
  ADD COLUMN IF NOT EXISTS factura_pdf_nombre VARCHAR(150),
  ADD COLUMN IF NOT EXISTS factura_xml BYTEA,
  ADD COLUMN IF NOT EXISTS factura_xml_nombre VARCHAR(150),
  ADD COLUMN IF NOT EXISTS factura_rfc VARCHAR(13),
  ADD COLUMN IF NOT EXISTS factura_total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS factura_subida_en TIMESTAMP,
  ADD COLUMN IF NOT EXISTS clave_descarga VARCHAR(20);

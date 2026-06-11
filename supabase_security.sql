-- ═══════════════════════════════════════════════════════════
-- Polla Mundialista 30X — endurecimiento de seguridad
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- Corrige: lectura pública de predicciones (fuga de privacidad)
-- ═══════════════════════════════════════════════════════════

-- 1. Quitar la política que permitía leer TODAS las predicciones
DROP POLICY IF EXISTS "predicciones_select_all" ON public.predicciones;

-- 2. Cada usuario solo puede leer SUS propias predicciones
CREATE POLICY "predicciones_select_own" ON public.predicciones
  FOR SELECT USING (auth.uid() = user_id);

-- 3. (Opcional) Si más adelante quieres un ranking público SIN exponer
--    datos crudos, usa una vista/función agregada con SECURITY DEFINER
--    en vez de abrir la tabla completa. Ejemplo de leaderboard anónimo:
--
--    CREATE OR REPLACE VIEW public.ranking AS
--      SELECT user_id, COUNT(*) AS predicciones_hechas
--      FROM public.predicciones
--      GROUP BY user_id;
--    (y expón solo lo que necesites, sin PII)

-- 4. Verificar que RLS sigue activo en ambas tablas
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predicciones ENABLE ROW LEVEL SECURITY;

-- 5. Forzar RLS incluso para el dueño de la tabla (defensa extra)
ALTER TABLE public.profiles     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.predicciones FORCE ROW LEVEL SECURITY;

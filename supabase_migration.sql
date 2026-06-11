-- ═══════════════════════════════════════════════════════════
-- Polla Mundialista 30X — migración Supabase
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════

-- 1. Perfiles de usuario (complementa auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  nombre      TEXT NOT NULL,
  celular     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Predicciones (una fila por usuario × partido)
CREATE TABLE IF NOT EXISTS public.predicciones (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  fecha_partidos  DATE NOT NULL,
  partido_id      TEXT NOT NULL,
  partido         TEXT NOT NULL,
  local_score     INTEGER NOT NULL DEFAULT 0,
  visitante_score INTEGER NOT NULL DEFAULT 0,
  marcador        TEXT NOT NULL,
  inicio          TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, partido_id)
);

-- 3. Row Level Security
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predicciones  ENABLE ROW LEVEL SECURITY;

-- profiles: cada usuario solo ve y edita el suyo
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- predicciones: todos pueden leer (ranking público), cada uno edita las suyas
CREATE POLICY "predicciones_select_all" ON public.predicciones
  FOR SELECT USING (true);
CREATE POLICY "predicciones_insert_own" ON public.predicciones
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "predicciones_update_own" ON public.predicciones
  FOR UPDATE USING (auth.uid() = user_id);

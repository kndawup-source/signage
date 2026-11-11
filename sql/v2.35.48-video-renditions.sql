-- Clinic Signage v2.35.48 : one video ID, multiple rendition URLs
-- Run separately in Supabase SQL Editor before deploying the web code.
-- This does NOT update original video URL, title, or playlist relationships.
BEGIN;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION public.player_get_state_lite(p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s jsonb;
BEGIN
  s := public.player_get_state(p_key);
  IF s IS NULL THEN RETURN NULL; END IF;
  RETURN s || jsonb_build_object(
    'playlist',coalesce((
      SELECT jsonb_agg(
        (x.e - 'thumbnail') ||
          CASE WHEN jsonb_typeof(v.variants)='object' THEN jsonb_build_object('variants',v.variants) ELSE '{}'::jsonb END
        ORDER BY x.o)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(s->'playlist')='array' THEN s->'playlist' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS x(e,o)
      LEFT JOIN public.videos v ON v.id = CASE
        WHEN (x.e->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (x.e->>'id')::uuid ELSE NULL END
    ),'[]'::jsonb),
    'emergency_video',CASE WHEN jsonb_typeof(s->'emergency_video')='object' THEN
      (s->'emergency_video') - 'thumbnail' ELSE coalesce(s->'emergency_video','null'::jsonb) END
  );
END $$;
REVOKE ALL ON FUNCTION public.player_get_state_lite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.player_get_state_lite(uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

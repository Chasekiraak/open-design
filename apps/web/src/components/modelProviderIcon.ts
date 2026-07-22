// Brand mark for a model id. AMR-style ids are `provider/model`
// (e.g. `anthropic/claude-sonnet-4-5`), so map the provider prefix to its
// bundled logo. Ids without a slash (e.g. the CLI-config default) return null
// and callers fall back to a neutral/agent mark instead of inventing artwork.
export function modelProviderIconSrc(
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null;
  const slash = modelId.indexOf('/');
  if (slash < 0) return null;
  const provider = modelId.slice(0, slash).toLowerCase();
  if (provider.includes('anthropic') || provider.includes('claude'))
    return '/agent-icons/claude.svg';
  if (provider.includes('openai') || provider.includes('gpt'))
    return '/model-icons/openai.svg';
  if (provider.includes('google') || provider.includes('gemini'))
    return '/model-icons/google-gemini.svg';
  if (provider.includes('xai') || provider.includes('grok'))
    return '/model-icons/x.svg';
  if (provider.includes('deepseek')) return '/agent-icons/deepseek.svg';
  if (provider.includes('qwen')) return '/agent-icons/qwen.svg';
  if (provider.includes('openrouter')) return '/model-icons/openrouter.svg';
  return null;
}

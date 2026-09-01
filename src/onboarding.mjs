export function extractVerificationUrl(text) {
  const value = String(text ?? "");
  const jsonMatch = value.match(/"verification_(?:url|uri_complete)"\s*:\s*"([^"]+)"/);
  if (jsonMatch) {
    try {
      return JSON.parse(`"${jsonMatch[1]}"`);
    } catch {
      return null;
    }
  }
  return value.match(/https:\/\/[^\s"']+/)?.[0] ?? null;
}

export function hasAvailableBot(statusText) {
  try {
    return JSON.parse(statusText).identities?.bot?.available === true;
  } catch {
    return false;
  }
}

export function effectiveProfile(profileListText) {
  try {
    const profiles = JSON.parse(profileListText);
    if (!Array.isArray(profiles)) return null;
    return profiles.find((profile) => profile?.effective === true)?.name ??
      profiles.find((profile) => profile?.active === true)?.name ??
      null;
  } catch {
    return null;
  }
}

// Masks everything but the last 4 digits so public feeds (recent entries,
// past winners, comments) never expose a full phone number — fullName is
// optional at signup (only avatarUrl is gated by requireCompleteProfile),
// so most entrants fall back to this.
export function displayNameFor(user: { fullName: string | null; phoneNumber: string }): string {
  if (user.fullName) return user.fullName
  return `•••${user.phoneNumber.slice(-4)}`
}

export const AccountInitials = {
  /** "Personal" reads P and "Attention Machine 1" reads A1. */
  tag(name: string): string {
    const initials = name
      .split(/\s+/u)
      .filter((word) => word.length > 0)
      .map((word) => [...word][0])
    if (initials.length === 0) return ''
    const letters = initials.length > 1 ? [initials[0], initials[initials.length - 1]] : [initials[0]]
    return letters.join('').toUpperCase()
  }
}

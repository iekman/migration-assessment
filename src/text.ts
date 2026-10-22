/** `pluralize(1, "function")` -> "1 function"; `pluralize(2, "function")` -> "2 functions". Pass an explicit plural for irregular forms. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

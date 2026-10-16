// The desktop app draws a Button as a native button and refuses one whose
// label isn't a single string: the `label` prop, or one string child. The
// terminal accepts more, so only this check catches it before a desktop does.

type Node = { type?: unknown; props?: { key?: string; label?: unknown }; children?: unknown[] }

// The keys of every Button in the drawn tree without a one-string label.
export function badLabels(tree: unknown): string[] {
  const bad: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    const n = node as Node
    if (n.type === 'Button') {
      const children = (n.children ?? []).filter(c => c !== null && c !== undefined && c !== false)
      const hasLabel = typeof n.props?.label === 'string'
      const isOneString = children.length === 1 && typeof children[0] === 'string'
      if (!(hasLabel ? children.length === 0 : isOneString)) bad.push(n.props?.key ?? '(no key)')
    }
    walk(n.children)
  }
  walk(tree)
  return bad
}

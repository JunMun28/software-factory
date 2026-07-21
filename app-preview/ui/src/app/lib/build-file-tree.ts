export type FileStatus = 'unchanged' | 'created' | 'modified' | 'deleted';

export interface WorkspaceFileEntry {
  path: string;
  status: FileStatus;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  status?: FileStatus;
  children: FileTreeNode[];
}

export function buildFileTree(files: WorkspaceFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    let currentPath = '';

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = index === parts.length - 1;

      let node = current.find((entry) => entry.name === part);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          status: isLast ? file.status : undefined,
          children: [],
        };
        current.push(node);
      } else if (isLast) {
        node.status = file.status;
        node.isDirectory = false;
      }

      current = node.children;
    }
  }

  sortTree(root);
  collapseChains(root);
  return root;
}

// Deep single-child directory chains (libs/ui/button/src/lib/…) waste
// horizontal space and truncate names; show them as one "a/b/c" node.
function collapseChains(nodes: FileTreeNode[]): void {
  for (const node of nodes) {
    while (
      node.isDirectory &&
      node.children.length === 1 &&
      node.children[0]!.isDirectory
    ) {
      const child = node.children[0]!;
      node.name = `${node.name}/${child.name}`;
      node.path = child.path;
      node.children = child.children;
    }
    collapseChains(node.children);
  }
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const node of nodes) {
    sortTree(node.children);
  }
}

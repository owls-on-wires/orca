// Allow importing .txt files as strings
declare module "*.prompt.txt" {
  const content: string;
  export default content;
}

// JSON imports are handled by resolveJsonModule in tsconfig

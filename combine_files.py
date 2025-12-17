import os

# Configuration
output_filename = "full_project_context.txt"
# Add any file extensions you want to include (or leave empty to include all)
allowed_extensions = {".html", ".css", ".js", ".json", ".py", ".txt"}
# Add any specific filenames you want to ignore
ignored_files = {output_filename, "combine_files.py", ".DS_Store"}

def main():
    # Get the current directory where the script is located
    current_dir = os.getcwd()
    
    with open(output_filename, "w", encoding="utf-8") as outfile:
        # Loop through all files in the directory
        for filename in os.listdir(current_dir):
            # Skip directories
            if not os.path.isfile(filename):
                continue

            # Skip ignored files
            if filename in ignored_files:
                continue

            # Skip files that don't match allowed extensions (if any are set)
            _, ext = os.path.splitext(filename)
            if allowed_extensions and ext.lower() not in allowed_extensions:
                continue

            try:
                with open(filename, "r", encoding="utf-8") as infile:
                    content = infile.read()
                    
                    # Write the header and content
                    outfile.write(f"=== START FILE: {filename} ===\n")
                    outfile.write(content)
                    outfile.write(f"\n=== END FILE: {filename} ===\n\n")
                    print(f"Processed: {filename}")
            
            except Exception as e:
                print(f"Skipping {filename} (Error reading file: {e})")

    print(f"\nSuccess! All content combined into: {output_filename}")

if __name__ == "__main__":
    main()
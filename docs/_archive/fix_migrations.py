import os
import glob
import re

migration_dir = "supabase/migrations"
files = glob.glob(os.path.join(migration_dir, "*.sql"))
files.sort()

# We only want files starting from 20260629090000
target_files = [f for f in files if os.path.basename(f) >= "20260629090000_"]

for file in target_files:
    with open(file, 'r') as f:
        content = f.read()

    # ADD COLUMN -> ADD COLUMN IF NOT EXISTS
    # Don't replace if it already has IF NOT EXISTS
    content = re.sub(r'ADD COLUMN\s+(?!IF NOT EXISTS)', 'ADD COLUMN IF NOT EXISTS ', content, flags=re.IGNORECASE)
    
    # CREATE TABLE -> CREATE TABLE IF NOT EXISTS
    content = re.sub(r'CREATE TABLE\s+(?!IF NOT EXISTS)', 'CREATE TABLE IF NOT EXISTS ', content, flags=re.IGNORECASE)
    
    # CREATE INDEX -> CREATE INDEX IF NOT EXISTS
    content = re.sub(r'CREATE INDEX\s+(?!IF NOT EXISTS)', 'CREATE INDEX IF NOT EXISTS ', content, flags=re.IGNORECASE)

    # CREATE TRIGGER -> CREATE OR REPLACE TRIGGER
    content = re.sub(r'CREATE TRIGGER\s+', 'CREATE OR REPLACE TRIGGER ', content, flags=re.IGNORECASE)

    with open(file, 'w') as f:
        f.write(content)

print(f"Processed {len(target_files)} files.")

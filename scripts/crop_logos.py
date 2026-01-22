from PIL import Image
import os

def check_and_crop(path):
    if not os.path.exists(path):
        print(f"File {path} not found")
        return
        
    img = Image.open(path).convert("RGBA")
    bbox = img.getbbox()
    if bbox:
        print(f"Image: {path}")
        print(f"Original size: {img.size}")
        print(f"Bounding box (content): {bbox}")
        
        # Crop to content
        cropped = img.crop(bbox)
        cropped.save(path)
        print(f"Successfully cropped {path} to {cropped.size}")
    else:
        print(f"Image {path} is empty!")

logos = [
    "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_dark_neon_fixed.png",
    "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_light_fixed.png"
]

for logo in logos:
    check_and_crop(logo)

#!/usr/bin/env python3
"""Turn a browser photo upload into a plain, provider-safe RGB PNG."""

import io
import json
import os
import sys

from PIL import Image, ImageCms, ImageOps


MAX_DIMENSION = 2048


def normalize(source, destination):
    with Image.open(source) as uploaded:
        # iPhones can hide multiple frames in an MPO behind a .jpg filename.
        # Only the primary frame represents the reference photo.
        uploaded.seek(0)
        image = ImageOps.exif_transpose(uploaded).copy()
        icc_profile = uploaded.info.get("icc_profile")

    image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
    # Indexed PNGs store transparency in their palette, without an A band.
    # Expand it before RGB conversion so hidden palette colors stay hidden.
    if "transparency" in image.info:
        image = image.convert("RGBA")
    alpha = image.getchannel("A") if "A" in image.getbands() else None
    image = image.convert("RGB")

    if icc_profile:
        try:
            source_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
            image = ImageCms.profileToProfile(
                image,
                source_profile,
                ImageCms.createProfile("sRGB"),
                outputMode="RGB",
            )
        except (ImageCms.PyCMSError, OSError, ValueError):
            # A malformed profile should not make an otherwise valid local
            # photo unusable. RGB conversion above is a safe fallback.
            pass

    if alpha is not None:
        alpha.thumbnail(image.size, Image.Resampling.LANCZOS)
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=alpha)
        image = background

    # Do not carry EXIF, MPO indexes, XMP, thumbnails, or source profiles into
    # the provider input. Pixel data is now ordinary sRGB.
    image.info.clear()
    temporary = f"{destination}.tmp"
    image.save(temporary, format="PNG", optimize=True)
    os.replace(temporary, destination)
    return {"width": image.width, "height": image.height, "mode": image.mode}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: normalize-image.py SOURCE DESTINATION")
    print(json.dumps(normalize(sys.argv[1], sys.argv[2])))

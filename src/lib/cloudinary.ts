import { v2 as cloudinary } from 'cloudinary'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

export function uploadAvatar(buffer: Buffer, userId: string): Promise<string> {
  // Dev mode (no Cloudinary account configured yet): store the image
  // inline as a data URL instead of calling out to Cloudinary. Fine for
  // local testing; real avatars need the real account before shipping.
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return Promise.resolve(`data:image/png;base64,${buffer.toString('base64')}`)
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'lucky/avatars',
        public_id: userId,
        overwrite: true,
        transformation: [
          { width: 512, height: 512, crop: 'fill', gravity: 'face' },
        ],
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'))
        resolve(result.secure_url)
      },
    )
    stream.end(buffer)
  })
}

/*
 * The fake responsive-web's reply composer chunk, an unnamed numeric one as on x.com, loaded only by its lazy
 * component's loader (`"TweetReplyInlineComposer"`, in the main chunk here): the composer and the media uploader it
 * uses, x.com's `upload(file, options)` (export `o7`). The uploader picks the kind and media_category from the file
 * (tweet_image, or `imageCategory`; tweet_gif; amplify_video, which needs `videoLimits`), then INIT, APPEND (1 MB
 * segments, multipart), FINALIZE and STATUS until processed, against `/i/media/upload.json` (x.com's is on
 * upload.x.com), and answers `{ mediaId, mediaKey }`. A failed processing rejects with X's words in `detailMessage`.
 */
//@chunk 9010
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9010],
  {
    666546(e,l,n){"use strict";n.d(l,{o7:()=>et,KC:()=>ek});const x={image:"tweet_image",gif:"tweet_gif",video:"amplify_video"},G={log:()=>{}},U="/i/media/upload.json",ck=()=>{let e=/(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie);return e?e[1]:""},ek=e=>"image/gif"===e.type?{kind:"gif",type:e.type}:/^image\/(png|jpeg|webp)$/.test(e.type)?{kind:"image",type:e.type}:/^video\//.test(e.type)?{kind:"video",type:e.type}:null,em=(e,t,r)=>fetch(U+"?"+new URLSearchParams(e).toString(),{method:t,credentials:"include",headers:{'x-csrf-token':ck()},...(r?{body:r}:{})}).then(async e=>{let t=204===e.status?{}:await e.json().catch(()=>({}));if(!e.ok){let r=new Error(`UploadError: HTTP-${e.status}`);throw r.errors=t.errors||[],r}return t}),es=e=>new Promise(t=>setTimeout(t,e));async function et(e,l={}){let n=ek(e);if(!n)throw new Error("Unsupported media file");let{kind:t,type:a}=n,i="image"===t&&null!=l.imageCategory?l.imageCategory:x[t],r=l.observability??G,s=l.withMediaUploadMetrics?{start:Date.now()}:null;if("video"===t&&!l.videoLimits)throw new Error("videoLimits are required for a video");if("video"===t&&e.size>l.videoLimits.maxFileSizeBytes)throw new Error("video too big");let u=await em({command:"INIT",total_bytes:e.size,media_type:a,media_category:i},"POST");r.log("init",u.media_id_string);for(let o=0,c=0;o<e.size;o+=1048576,c++){let d=new FormData;d.append("media",e.slice(o,o+1048576)),await em({command:"APPEND",media_id:u.media_id_string,segment_index:c},"POST",d),l.onProgress&&l.onProgress(Math.min(1,(o+1048576)/e.size))}let f=await em({command:"FINALIZE",media_id:u.media_id_string},"POST"),p=f.processing_info;for(;p&&("pending"===p.state||"in_progress"===p.state);)await es(1e3*(p.check_after_secs??1)),p=(await em({command:"STATUS",media_id:u.media_id_string},"GET")).processing_info;if(p&&"failed"===p.state){let e=new Error("UploadError: processing failed");throw e.detailMessage=p.error?.message??p.error?.name,e}return s&&r.log("metrics",Date.now()-s.start),null==f.media_key?{mediaId:f.media_id_string}:{mediaId:f.media_id_string,mediaKey:f.media_key}}},
    900010(e,t,n){n.r(t),n.d(t,{TweetReplyInlineComposer:()=>v,default:()=>v});var a=n(666546);let v=e=>null},
  },
]);

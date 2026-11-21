/*
 * The fake responsive-web's lazy chunks for Home, as x.com splits them: a chunk shared with Compose and LoggedInMain
 * holding the home timelines' endpoint factory (`fetchHome`: HomeTimeline, For you; `fetchHomeLatest(`:
 * HomeLatestTimeline, Following) and its queries, and `bundle.HomeTimeline` with the tab's timeline module (its
 * "Popular" sort ranks) and the screen the route requires. As on x.com, a call given a `userId` sends the page's own
 * list of posts seen (`seenTweetIds`, POSTed) and clears it; one given none sends nothing of the kind. test/fake-x.ts
 * serves each part as its own file.
 */
//@chunk 9006
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9006],
  {
    128801(e){e.exports={queryId:"Fk7HomeTlQ00016",operationName:"HomeTimeline",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_graphql_timeline_navigation_enabled"],fieldToggles:["withPayments"]}}},
    128802(e){e.exports={queryId:"Fk7HomeLtQ00017",operationName:"HomeLatestTimeline",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_graphql_timeline_navigation_enabled"],fieldToggles:["withPayments"]}}},
    128803(e,t,r){"use strict";let n=new Map;r.d(t,{U:()=>a});let a=e=>({get:()=>{let t=n.get(e);return t||n.set(e,t=(()=>{let s=["1856000000000000999"];return{getTweets:()=>s.slice(),clearTweets:()=>{s=[]}}})()),t}})},
    128882(e,t,r){"use strict";var n=r(128803),i=r(128801),l=r(128802),o=r(768276);let c=(e,t)=>!t?.home?.home_timeline_urt,d=({apiClient:e,featureSwitches:t})=>({fetchHome({count:r,cursor:a,isPaymentsEnrolled:l,requestContext:d,snoozedTopicIds:u,tag:p,timeout:m,userId:h}){let g=h?(0,n.U)(h).get():void 0,_=!!(g&&g.getTweets().length>0),b={count:r,cursor:a,includePromotedContent:!0,requestContext:d,tag:p,topicIds:u&&u.length>0?u.map(e=>e.startsWith("-")?e:`-${e}`):void 0,withCommunity:t.isTrue("c9s_enabled")};return e.graphQL(i,_?{...b,seenTweetIds:_?g?.getTweets():[]}:b,c,{forcePost:_,timeout:m,fieldToggles:{withPayments:!!l}}).then(e=>(_&&g?.clearTweets(),e?.home?.home_timeline_urt||o.yB))},fetchHomeLatest({count:r,cursor:a,enableRanking:i,isPaymentsEnrolled:d,requestContext:u,timeout:p,userId:m}){let h=m?(0,n.U)(m).get():void 0,g=!!(h&&h.getTweets().length>0),_={count:r,cursor:a,enableRanking:i,includePromotedContent:!0,requestContext:u};return e.graphQL(l,g?{..._,seenTweetIds:g?h?.getTweets():[]}:_,c,{forcePost:g,timeout:p,fieldToggles:{withPayments:!!d}}).then(e=>(g&&h?.clearTweets(),e?.home?.home_timeline_urt||o.yB))}});r.dn(d),r.d(t,["A",0,d])},
  },
]);
//@chunk 9007
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9007],
  {
    128890(e,t,s){var a=s(128882),i=s(250100);s.d(t,["A",0,(e,t)=>(0,i.A)({timelineId:`home-${e}`,network:{getEndpoint:t=>"Popular"===e?t.withEndpoint(a.A).fetchHome:t.withEndpoint(a.A).fetchHomeLatest,getEndpointParams:({count:s,cursor:a},i)=>({count:s,cursor:"string"==typeof a?a:void 0,enableRanking:"Popular"===e,userId:i?.session?.user_id,requestContext:a?void 0:"launch"})},context:"FETCH_HOME_TIMELINE"})])},
    128899(e,t,s){s.r(t),s.d(t,{HomeTimelineScreen:()=>v,default:()=>v});var a=s(128890);let v=e=>null},
  },
]);

/*
 * The fake responsive-web's lazy chunks for a post's activity (its Likes and Reposts tabs), as x.com splits them: a
 * chunk shared with QuoteTweetActivity holding the endpoint factory (`fetchLikedBy:(`, `fetchRetweetedBy`,
 * `fetchEditHistory`; Favoriters, Retweeters) and its queries, and `bundle.TweetActivity` with the tab's timeline module
 * and the screen the route requires. test/fake-x.ts serves each part as its own file.
 */
//@chunk 9004
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9004],
  {
    706601(e){e.exports={queryId:"Fk7FavoritersQ13",operationName:"Favoriters",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_graphql_timeline_navigation_enabled"],fieldToggles:[]}}},
    706602(e){e.exports={queryId:"Fk7RetweetersQ14",operationName:"Retweeters",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_graphql_timeline_navigation_enabled"],fieldToggles:[]}}},
    706603(e){e.exports={queryId:"Fk7EditHistQ0015",operationName:"TweetEditHistory",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}}},
    424242(e,_,t){"use strict";var a=t(706601),i=t(706602),o=t(706603),r=t(768276);let s=({apiClient:e,featureSwitches:_})=>({fetchLikedBy:({count:t,cursor:i,enableRanking:o=!1,tweetId:s})=>e.graphQL(a,{tweetId:s,count:t,cursor:i,enableRanking:o,includePromotedContent:!0},(e,_)=>!_?.favoriters_timeline?.timeline).then(e=>e?.favoriters_timeline?.timeline||r.yB),fetchRetweetedBy:({count:t,cursor:a,enableRanking:o=!1,tweetId:s})=>e.graphQL(i,{tweetId:s,count:t,cursor:a,enableRanking:o,includePromotedContent:!0},(e,_)=>!_?.retweeters_timeline?.timeline).then(e=>e?.retweeters_timeline?.timeline||r.yB),fetchEditHistory:({tweetId:t})=>e.graphQL(o,{tweetId:t},(e,_)=>!_?.tweet_result_by_rest_id?.result).then(e=>e?.tweet_result_by_rest_id?.result?.edit_history_timeline?.timeline||r.yB)});t.dn(s),t.d(_,["A",0,s])},
  },
]);
//@chunk 9005
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9005],
  {
    562600(e,t,s){var a=s(424242),i=s(250100);s.d(t,["A",0,(e,t)=>(0,i.A)({timelineId:`favoriters-${t?"ranked":""}GraphQL-${e}`,network:{getEndpoint:e=>e.withEndpoint(a.A).fetchLikedBy,getEndpointParams:({count:s,cursor:a})=>({count:s,cursor:"string"==typeof a?a:void 0,enableRanking:t,tweetId:e})},context:"FETCH_TWEET_ACTIVITY_LIKES"})])},
    838383(e,t,s){s.r(t),s.d(t,{TweetActivityScreen:()=>v,default:()=>v});var a=s(562600);let v=e=>null},
  },
]);

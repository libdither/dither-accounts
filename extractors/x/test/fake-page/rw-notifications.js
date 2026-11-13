/*
 * The fake responsive-web's lazy chunks for the Notifications tab, as x.com splits them: `bundle.Notifications` with
 * the tab's module (the endpoint factory with `fetchNotifications:(`, not exported, registered with `n.dn`; the
 * timeline modules made with it; `updateLastSeenCursor`, which marks notifications seen) and its query, and a shared
 * chunk the module needs. test/fake-x.ts serves each part as its own file.
 */
//@chunk 9002
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9002],
  {
    484284(e,t,n){"use strict";let r=Object.freeze({All:"all",Mentions:"mentions",Priority:"priority",Verified:"verified",Subscribers:"subscribers"});n.d(t,["n",0,r])},
  },
]);
//@chunk 9001
(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([
  [9001],
  {
    417142(e){e.exports={queryId:"Fk7NotifTmlnQ004",operationName:"NotificationsTimeline",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_graphql_timeline_navigation_enabled"],fieldToggles:[]}}},
    857237(e,t,n){"use strict";n.r(t),n.d(t,{NOTIFICATIONS_CONTEXT:()=>d,default:()=>p,notificationsModule:()=>u,updateLastSeenCursor:()=>f});var r=n(250100),o=n(417142),i=n(768276),a=n(54956),s=n(484284);let l=e=>!e?.viewer_v2?.user_results?.result?.notification_timeline?.timeline,c=({apiClient:e,featureSwitches:t})=>({fetchNotifications:({count:t,cursor:n,timelineType:r,userId:a})=>e.graphQL(o,{timeline_type:r,cursor:n,count:t},l).then(e=>e?.viewer_v2?.user_results?.result?.notification_timeline?.timeline||i.yB)});n.dn(c);let d="FETCH_NOTIFICATIONS_TIMELINE",h=new Map([[s.n.All,"All"],[s.n.Mentions,"Mentions"],[s.n.Priority,"Priority"],[s.n.Verified,"Verified"],[s.n.Subscribers,"SuperFollowers"]]),u=(e=s.n.All,t)=>{let n=h.get(e)||"All";return(0,r.A)({timelineId:`notifications-${e}-${t??""}`,network:{getEndpoint:e=>e.withEndpoint(c).fetchNotifications,getEndpointParams:({count:e,cursor:r,polling:o})=>({count:e,cursor:"string"==typeof r?r:void 0,timelineType:n,userId:t})},context:d,perfKey:"notifications",staleIntervalMs:5e3,actAsUserId:t})},f=(e=s.n.All,t)=>(n,r,{api:o})=>o.withEndpoint(a.A).updateNotificationsLastSeenCursor({cursor:"DAABDAAB-seen",type:e}).then(()=>n({type:"NOTIFICATIONS_SEEN"})),m=u(s.n.All),p=m},
  },
]);

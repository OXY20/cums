/**
 * 路由：学生端与教师端分离，教师端要求登录。
 */
import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/api'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/student' },

    // 学生端
    {
      path: '/student',
      name: 'student-home',
      component: () => import('@/views/StudentHome.vue'),
    },
    {
      path: '/student/sessions/:id',
      name: 'student-session',
      component: () => import('@/views/SessionDetail.vue'),
      props: true,
    },
    {
      path: '/student/courses/:courseId',
      name: 'student-course',
      component: () => import('@/views/CourseHome.vue'),
      props: true,
    },
    {
      path: '/student/downloads',
      name: 'student-downloads',
      component: () => import('@/views/DownloadCenter.vue'),
    },

    // 登录
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },

    // 教师端
    {
      path: '/admin',
      component: () => import('@/views/admin/AdminLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', redirect: '/admin/console' },
        {
          path: 'console',
          name: 'admin-console',
          component: () => import('@/views/admin/ConsoleView.vue'),
        },
        {
          path: 'courses',
          name: 'admin-courses',
          component: () => import('@/views/admin/CourseListView.vue'),
        },
        {
          path: 'courses/:courseId',
          name: 'admin-course-detail',
          component: () => import('@/views/admin/CourseDetailView.vue'),
          props: true,
        },
        {
          path: 'resources',
          name: 'admin-resources',
          component: () => import('@/views/admin/ResourceView.vue'),
        },
        {
          path: 'submissions',
          name: 'admin-submissions',
          component: () => import('@/views/admin/SubmissionView.vue'),
        },
        {
          path: 'lessons/:lessonId/review',
          name: 'admin-lesson-review',
          component: () => import('@/views/admin/LessonReviewView.vue'),
        },
        {
          path: 'roster',
          name: 'admin-roster',
          component: () => import('@/views/admin/RosterView.vue'),
        },
        {
          path: 'system',
          name: 'admin-system',
          component: () => import('@/views/admin/SystemView.vue'),
        },
      ],
    },

    { path: '/:pathMatch(.*)*', redirect: '/student' },
  ],
})

// 未登录访问教师端时跳转到登录页
router.beforeEach((to) => {
  if (to.meta.requiresAuth && !getToken()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

export default router
